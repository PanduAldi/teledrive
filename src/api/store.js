// Index storage: sharded JSON messages across mapper topics.
//
// Shard assignment: hash(node.id) % MAPPERS.length — deterministic on every
// device, so no local state is needed to find a node.
//
// Registry (which messages hold shards + the global sequence) is mirrored into
// the backup topic, which is what makes the drive survivable from a fresh
// browser: the UI can adopt an existing drive by pasting the backup message link.

import { MAPPERS, BACKUP_TOPIC } from "./config.js";
import { sendText, editMessage, readMessage } from "./tg.js";
import { kv } from "./kv.js";

const REG_KEY = "tdw.registry.v1";
const ALPHA = "abcdefghijklmnopqrstuvwxyz0123456789";

export function uid() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => ALPHA[b % ALPHA.length]).join("");
}

export function mapperFor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % MAPPERS.length;
}

export function loadReg() {
  try { return JSON.parse(kv.get(REG_KEY)) || null; } catch { return null; }
}
export function saveReg(r) { kv.set(REG_KEY, JSON.stringify(r)); }
export function clearReg() { kv.del(REG_KEY); }

export async function loadAll(onStep) {
  const reg = loadReg();
  if (!reg?.shards) return { seq: 0, nodes: {}, reg: null };
  const nodes = {};
  for (const topicId of MAPPERS) {
    for (const mid of reg.shards[topicId] || []) {
      try {
        const m = await readMessage(mid);
        if (m.text) Object.assign(nodes, JSON.parse(m.text).nodes || {});
      } catch (e) {
        console.warn(`shard ${topicId}/${mid} gagal dibaca:`, e.message);
      }
      onStep?.();
    }
  }
  return { seq: reg.seq || 0, nodes, reg };
}

// Writes every shard that actually exists, then the registry backup.
export async function commit(state) {
  const byTopic = {};
  for (const id in state.nodes) (byTopic[mapperFor(id)] ||= {})[id] = state.nodes[id];

  const reg = state.reg || { shards: {} };
  reg.seq = state.seq;
  reg.updated = Date.now();

  // Sequential: parallel shard writes burst past the group's per-chat flood
  // limit (20 messages/min) and earn a 429. Four small edits cost nothing.
  for (let i = 0; i < MAPPERS.length; i++) {
    const topicId = MAPPERS[i];
    const nodes = byTopic[i] || {};
    const text = JSON.stringify({ v: 1, i, seq: state.seq, nodes });
    const mid = (reg.shards[topicId] || [])[0];
    if (mid) {
      try { await editMessage(mid, text); }
      catch (e) {
        if (!/not modified/i.test(e.message)) throw e; // identical content = already saved
      }
      continue;
    }
    if (!Object.keys(nodes).length) continue; // never create an empty shard message
    const m = await sendText(topicId, text);
    reg.shards[topicId] = [m.message_id];
  }

  saveReg(reg);
  state.reg = reg;
  // Backup is best-effort: a stale backup must never block a user action.
  try {
    const text = JSON.stringify({ v: 1, reg, ts: Date.now() });
    if (reg.backupMid) await editMessage(reg.backupMid, text);
    else reg.backupMid = (await sendText(BACKUP_TOPIC, text)).message_id;
    saveReg(reg);
  } catch (e) {
    console.warn("backup gagal:", e.message);
  }
  return reg;
}
