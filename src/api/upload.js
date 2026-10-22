// Chunked upload (metadata lives in the index, bytes live in the storage topic).
//
// VERIFIED LIMITS (live Bot API probes, 2026-10):
//  - sendDocument accepts up to 50 MB per call from a browser.
//  - getFile can only serve files ≤ 20 MB. That is the real ceiling for
//    DOWNLOADING via the browser in direct mode.
//  - api.telegram.org/file/... sends NO CORS headers (OPTIONS → 405), so the
//    browser can only consume it through native tags: <img src>, <video src>,
//    <a download>. Never fetch() a file URL in direct mode.
//  - A Cloudflare Worker (worker/ in this repo) proxies both APIs, injects the
//    token server-side and adds CORS → removes the 20 MB ceiling and enables
//    real progress/range downloads.

import { sendDoc, call, delHere } from "./tg.js";
import { topics } from "./config.js";

export const DIRECT_MAX = 20 * 1024 * 1024; // hard Bot API download ceiling in direct mode
export const CHUNK = 19 * 1024 * 1024;      // safety margin under that ceiling

export async function uploadFile(file, onProgress, workerMode) {
  // direct mode with an oversized file: refuse early instead of uploading
  // bytes the user can never download back.
  if (!workerMode && file.size > DIRECT_MAX) {
    throw new Error(
      `File ${(file.size / 1048576).toFixed(1)} MB melebihi batas 20 MB Bot API. ` +
      `Set Cloudflare Worker URL di Settings, atau pilih file lebih kecil.`
    );
  }
  const chunks = Math.max(1, Math.ceil(file.size / CHUNK));
  if (chunks === 1) {
    const msg = await sendDoc(topics.storage, file, JSON.stringify({ i: 0, n: 1, name: file.name }));
    onProgress?.(1);
    return { mid: msg.message_id, chMids: null, ch: null };
  }
  // multi-chunk (worker mode / large files): each chunk needs its own getFile,
  // so the mid list is what lets a later download stitch them back together.
  const mids = [];
  for (let i = 0; i < chunks; i++) {
    const blob = file.slice(i * CHUNK, (i + 1) * CHUNK);
    const msg = await sendDoc(topics.storage, blob, JSON.stringify({ i, n: chunks, name: file.name }));
    mids.push(msg.message_id);
    onProgress?.((i + 1) / chunks);
  }
  return { mid: null, chMids: mids, ch: chunks };
}

// URL for one stored document. In direct mode this is a token-bearing Telegram
// URL usable ONLY as a native src/href. In worker mode the same path is fetched.
export async function urlForFile(node) {
  const firstMid = node.mid || node.chMids?.[0];
  if (!firstMid) throw new Error("file tidak punya pesan penyimpanan");
  const fileId = await fileIdOf(firstMid);
  const f = await call("getFile", { file_id: fileId });
  const { fileBase } = await import("./tg.js");
  return { url: `${fileBase()}/${f.file_path}`, size: f.file_size ?? node.s, path: f.file_path, fileId };
}

export async function fileIdOf(messageId) {
  // Documents are addressed by file_id; we keep message ids in the index and
  // recover the file_id from the stored message on demand.
  const { readMessage } = await import("./tg.js");
  const m = await readMessage(messageId);
  if (!m.fileId) throw new Error("pesan bukan dokumen");
  return m.fileId;
}

export function triggerDownload(url, name) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export async function deleteStorageMessage(mid) {
  return delHere(mid).catch(() => {});
}
