// Filesystem ops on the in-memory node map + commit orchestration.
// Node shapes (see store.js): folder {id,k:"d",n,p,c[],ts}, file {id,k:"f",n,s,t,p,mid|chMids,ts}
// Recycle bin = a virtual root id "recycle" (no Telegram message); emptying it
// deletes the storage-topic messages → BYD (Bulletproof Yellow Duckling: data gone for real).

import { loadAll, commit, uid } from "./store.js";
import { delHere } from "./tg.js";

let state = { seq: 0, nodes: {}, reg: null };

export async function init() {
  state = await loadAll();
  return state;
}
export const getNodes = () => state.nodes;
export const getSeq = () => state.seq;
export const childrenOf = (pid) => Object.values(state.nodes).filter((n) => n.p === (pid || ""));

export function pathOf(id) {
  const out = [];
  let p = id;
  while (p && state.nodes[p]) { out.unshift(state.nodes[p]); p = state.nodes[p].p; }
  return out;
}

export async function createFolder(name, parent) {
  const id = uid();
  state.nodes[id] = { id, k: "d", n: name, p: parent || "", c: [], ts: Date.now() };
  const par = state.nodes[parent];
  if (par) par.c.push(id);
  state.seq += 1;
  await commit(state);
  return id;
}

export async function addFile({ name, size, type, mid, chMids, chunks, parent }) {
  const id = uid();
  state.nodes[id] = {
    id, k: "f", n: name, s: size, t: type, p: parent || "",
    mid: mid ?? null, chMids: chMids ?? null, ch: chunks ?? null, ts: Date.now(),
  };
  const par = state.nodes[parent];
  if (par) par.c.push(id);
  state.seq += 1;
  await commit(state);
  return id;
}

export async function rename(id, name) {
  const n = state.nodes[id];
  if (!n || !name.trim()) throw new Error("nama tidak valid");
  n.n = name.trim();
  state.seq += 1;
  await commit(state);
}

export async function move(id, newParent) {
  const n = state.nodes[id];
  if (!n) throw new Error("node tidak ada");
  if (newParent === id) throw new Error("tidak bisa pindah ke dirinya sendiri");
  for (let p = newParent; p; p = state.nodes[p]?.p) {
    if (p === id) throw new Error("tidak bisa pindah ke dalam subfolder sendiri");
  }
  if (n.p && state.nodes[n.p]) state.nodes[n.p].c = state.nodes[n.p].c.filter((c) => c !== id);
  n.p = newParent || "";
  const target = state.nodes[newParent];
  if (target) target.c.push(id);
  if (n.p === "recycle") n.d = 1; else delete n.d;
  state.seq += 1;
  await commit(state);
}

export const trash = (id) => move(id, "recycle");
export const restore = (id) => move(id, "");

function collectFiles(id, acc = []) {
  const n = state.nodes[id];
  if (!n) return acc;
  if (n.k === "f") acc.push(n);
  for (const c of [...(n.c || [])]) collectFiles(c, acc);
  return acc;
}

function collectNodes(id, acc = []) {
  const n = state.nodes[id];
  if (!n) return acc;
  acc.push(n);
  for (const c of [...(n.c || [])]) collectNodes(c, acc);
  return acc;
}

// Irreversible: storage messages are deleted, nodes dropped from the index.
export async function purge(id) {
  const nodes = collectNodes(id);
  // capture the parent BEFORE the node objects are dropped — otherwise the
  // parent's child list keeps a dangling id and the folder shows a ghost row.
  const parentId = state.nodes[id]?.p;
  for (const n of nodes) {
    if (n.k !== "f") continue;
    if (n.mid) await delHere(n.mid).catch((e) => console.warn("del mid:", e.message));
    for (const cm of n.chMids || []) await delHere(cm).catch(() => {});
  }
  for (const n of nodes) delete state.nodes[n.id];
  const par = state.nodes[parentId];
  if (par?.c) par.c = par.c.filter((c) => c !== id);
  state.seq += 1;
  await commit(state);
}

export async function emptyBin() {
  for (const n of childrenOf("recycle")) await purge(n.id);
}
