// End-to-end exercise of the real src/api layer against the live Bot API.
// Run: node scripts/test-e2e.mjs   (uses the local Hermes bot token; never commit it)
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert";

const env = readFileSync(`${process.env.HOME || process.env.USERPROFILE}/AppData/Local/hermes/.env`, "utf8");
const TOKEN = env.match(/TELEGRAM_BOT_TOKEN=(.+)/)[1].trim();
const DM_USER = "343647452";

const { configure, call, sendText, readMessage, editMessage, delHere } = await import("../src/api/tg.js");
configure({ token: TOKEN, chat: "-1003539953822", dmUser: DM_USER });

const { MAPPERS, BACKUP_TOPIC } = await import("../src/api/config.js");
const { loadAll, commit, uid, mapperFor } = await import("../src/api/store.js");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};
const created = [];

try {
  console.log("1) send + read back a shard-shaped message");
  const nodes = { [uid()]: { id: "x", k: "d", n: "probe", p: "", c: [], ts: 1 } };
  const text = JSON.stringify({ v: 1, i: 0, seq: 7, nodes });
  const m = await sendText(MAPPERS[0], text);
  created.push(m.message_id);
  const back = await readMessage(m.message_id);
  ok("text round-trips through forwardMessage", back.text === text, back.text);
  const parsed = JSON.parse(back.text);
  ok("nodes survive JSON round-trip", Object.keys(parsed.nodes).length === 1);

  console.log("2) commit writes 4 shards + registry backup, empty shards skipped");
  const state = { seq: 2, nodes: {}, reg: null };
  for (let i = 0; i < 4; i++) state.nodes[uid()] = { id: uid(), k: "d", n: `f${i}`, p: "", c: [], ts: 1 };
  const reg = await commit(state);
  ok("registry gained a backup message id", !!reg.backupMid, JSON.stringify(reg.shards));
  const touched = Object.keys(reg.shards);
  ok("between 1 and 4 shards written", touched.length > 0 && touched.length <= 4, String(touched.length));
  for (const t of touched) created.push(reg.shards[t][0]);
  created.push(reg.backupMid);

  console.log("3) edit a shard message (the mutation path)");
  const target = reg.shards[touched[0]][0];
  await editMessage(target, JSON.stringify({ v: 1, i: 0, seq: 3, nodes: { a: { id: "a", k: "d", n: "edited", p: "", c: [], ts: 1 } } }));
  const after = await readMessage(target);
  ok("edit reflected on read", JSON.parse(after.text).seq === 3, after.text);

  console.log("4) re-commit reuses the same message ids (no chat spam)");
  const reg2 = await commit(state);
  ok("same shard mid reused", reg2.shards[touched[0]][0] === target, `${reg2.shards[touched[0]][0]} vs ${target}`);

  console.log("5) mapperFor is stable and in range");
  const ids = Array.from({ length: 200 }, uid);
  ok("all ids map into 0..3", ids.every((i) => { const v = mapperFor(i); return Number.isInteger(v) && v >= 0 && v < MAPPERS.length; }));
  ok("mapping is deterministic", ids.every((i) => mapperFor(i) === mapperFor(i)));
  const spread = new Set(ids.map(mapperFor));
  ok("all 4 shards get used", spread.size === 4, `used ${spread.size}`);
} catch (e) {
  fail++; console.log("  FAIL exception:", e.message);
} finally {
  console.log(`\ncleanup (${created.length} test messages)`);
  for (const mid of created) {
    try { await delHere(mid); console.log(`  deleted ${mid}`); } catch (e) { console.log(`  skip ${mid}: ${e.message}`); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
