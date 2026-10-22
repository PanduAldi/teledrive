// Index = one JSON message per mapper topic (topic 55..58). Layout:
//   { v: 1, seq: <global counter>, nodes: { id: {id, n(ame), s(ize), t(ype), p(arent), mid|ch[], k(ind f|d), ts} } }
// Topic choice = hash(id) % 4, so any node lives in exactly one mapper.
// One message edit = one tree mutation. Backup rewrites the same JSON into topic 59.

import { readMessage, sendText, delHere, editMessage } from "./tg.js";

export const MAPPERS = [55, 56, 57, 58];
export const BACKUP_TOPIC = 59;
export const RECYCLE_TOPIC = 60;
export const STORAGE_TOPIC = 61;

const seqKey = "__seq__";

function mapperFor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return MAPPERS[h % MAPPERS.length];
}

async function readMapper(topicId) {
  // Find the index message: the only non-deleted service message in this topic.
  // We track the mid in localStorage after every write; on cold start, scan by
  // forwarding is impossible without the mid, so we store it client-side and
  // fall back to empty + doctor on miss.
  const mid = localStorage.getItem(`idx_mid_${topicId}`);
  if (!mid) return { mid: null, seq: 0, nodes: {} };
  try {
    const m = await readMessage(Number(mid));
    if (!m.text) throw new Error("index message is not text");
    const data = JSON.parse(m.text);
    return { mid: Number(mid), seq: data.seq ?? 0, nodes: data.nodes ?? {} };
  } catch (e) {
    // mid stale (message deleted manually) → try the other mappers? No: index
    // for THIS mapper is gone. Return empty; doctor flow can restore from backup.
    console.warn(`mapper ${topicId} unreadable:`, e.message);
    return { mid: null, seq: 0, nodes: {} };
  }
}

async function writeMapper(topicId, mid, seq, nodes) {
  const text = JSON.stringify({ v: 1, seq, nodes });
  if (mid) {
    await editMessage(mid, text);
    return mid;
  }
  const m = await sendText(topicId, text);
  localStorage.setItem(`idx_mid_${topicId}`, String(m.message_id));
  return m.message_id;
}

export async function loadIndex() {
  const seqs = [];
  const parts = {};
  for (const t of MAPPERS) {
    parts[t] = await readMapper(t);
    seqs.push(parts[t].seq);
  }
  return { parts, seq: Math.max(0, ...seqs) };
}

export async function saveMapper(all, topicId, seq) {
  const part = all.parts[topicId];
  await writeMapper(topicId, part.mid, seq, part.nodes);
}

// Global monotonic counter shared across mappers: stored on mapper 0's row.
export function nextId(seq) { return seq + 1; }

export { seqKey, mapperFor, readMapper, writeMapper };
