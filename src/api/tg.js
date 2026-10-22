// Telegram Bot API transport.
//
// Two modes:
//  1. direct   — browser calls api.telegram.org with the user token. CORS is open
//                on the API domain (verified). File URLs have NO CORS → media is
//                attached as <img>/<video>/<a download>, never fetch()ed. getFile
//                caps at 20 MB → that is the per-chunk/per-file ceiling here.
//  2. worker   — all calls go through a Cloudflare Worker that injects the token
//                server-side and adds CORS on file downloads. Removes the 20 MB
//                ceiling and keeps the token out of the browser.

let TOKEN = "";
let WORKER = ""; // "" = direct mode
let CHAT = "";
export let DM_USER = "";

export function transport() {
  return { token: TOKEN, worker: WORKER, chat: CHAT };
}

export function configure({ token = "", worker = "", chat = "", dmUser = "" }) {
  TOKEN = token.replace(/^bot/, "");
  WORKER = worker.trim().replace(/\/+$/, "");
  CHAT = chat;
  DM_USER = String(dmUser || "");
}

export function apiBase() {
  return WORKER || `https://api.telegram.org/bot${TOKEN}`;
}
export function fileBase() {
  return WORKER ? `${WORKER}/file` : `https://api.telegram.org/file/bot${TOKEN}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Transport retry: some networks black-hole ~a third of new TLS connections to
// api.telegram.org (10 s connect timeout); a fresh socket usually succeeds.
// Also honours Telegram flood control (429 carries parameters.retry_after).
// Only network errors and 429/5xx are retried — never a 4xx logic error, and the
// body must be replayable (URLSearchParams / FormData, never a stream).
async function fetchRetry(url, opts, { attempts = 4, timeoutMs = 15000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      // A blackholed TCP connect never errors on its own — abort it so the
      // retry can open a fresh socket instead of hanging the UI forever.
      const signal = AbortSignal.timeout(timeoutMs);
      const res = await fetch(url, { ...opts, signal });
      if (res.status === 429) {
        let wait = 3;
        try { wait = (await res.clone().json())?.parameters?.retry_after ?? 3; } catch { /* keep default */ }
        lastErr = new Error(`rate limited (retry_after ${wait}s)`);
        if (i === attempts - 1) break;
        await sleep(Math.min(wait, 60) * 1000);
        continue;
      }
      if (res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        if (i === attempts - 1) break;
        await sleep(700 * (i + 1));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (i === attempts - 1) break;
      await sleep(400 * (i + 1));
    }
  }
  throw lastErr;
}

// Direct Bot API call with an explicit token — used before the vault is unlocked
// (setup wizard, credential probe) where the module-level transport isn't armed.
export async function callWith(token, method, fields = {}, opts) {
  const body = new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, String(v)]));
  const url = `https://api.telegram.org/bot${String(token).replace(/^bot/, "")}/${method}`;
  const res = await fetchRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  }, opts);
  const data = await res.json();
  if (!data.ok) {
    const e = new Error(`TG ${method}: ${data.description || res.status}`);
    e.code = data.error_code;
    throw e;
  }
  return data.result;
}

async function callRaw(method, body, isForm) {
  const res = await fetchRetry(worked(method), {
    method: "POST",
    headers: isForm ? undefined : { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json();
  if (!data.ok) {
    const e = new Error(`TG ${method}: ${data.description || res.status}`);
    e.code = data.error_code;
    throw e;
  }
  return data.result;
}

function worked(method) {
  return WORKER ? `${WORKER}/${method}` : `${apiBase()}/${method}`;
}

export async function call(method, fields = {}) {
  return callRaw(method, new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, String(v)])), false);
}

// ── Messaging primitives (verified against live Bot API) ─────────────────

export const sendText = (topicId, text) =>
  call("sendMessage", { chat_id: CHAT, message_thread_id: topicId, text });

export async function sendDoc(topicId, blob, caption) {
  const fd = new FormData();
  fd.append("chat_id", CHAT);
  fd.append("message_thread_id", String(topicId));
  fd.append("document", blob, "chunk");
  fd.append("caption", caption);
  return callRaw("sendDocument", fd, true);
}

export const delHere = (messageId) => call("deleteMessage", { chat_id: CHAT, message_id: messageId });
export const delIn = (target, messageId) => call("deleteMessage", { chat_id: target, message_id: messageId });

export const editMessage = (messageId, text) =>
  call("editMessageText", { chat_id: CHAT, message_id: messageId, text });

// SELECT: forward to the user's own DM (bot can read the full forwarded payload),
// extract, delete the copy. The topic (our database) is never modified.
export async function readMessage(messageId) {
  if (!DM_USER) throw new Error("Belum ada user DM — buka app dari Settings sekali dulu");
  const copy = await call("forwardMessage", {
    chat_id: DM_USER, from_chat_id: CHAT, message_id: messageId,
  });
  const payload = {
    text: copy.text ?? null,
    caption: copy.caption ?? null,
    fileId: copy.document?.file_id ?? null,
    raw: copy,
  };
  delIn(DM_USER, copy.message_id).catch(() => {});
  return payload;
}

// ── Media URLs (native tags only — no CORS on /file/) ────────────────────

export async function fileUrl(fileId) {
  const f = await call("getFile", { file_id: fileId });
  return { url: `${fileBase()}/${f.file_path}`, size: f.file_size ?? 0 };
}

export function directUrl(token, fileId) {
  // one-shot helper used after getFile when in direct mode
  return `${fileBase()}/${fileId}`;
}
