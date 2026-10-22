// Credential vault. localStorage holds ONE encrypted blob; the Telegram token,
// user id and topic configuration live inside it. Unlock = decrypt (wrong
// password fails AES-GCM authentication). The derived key is kept in
// sessionStorage so a page refresh does not re-prompt, and dies with the tab.

import { deriveRaw, encryptJSON, decryptJSON, newSalt, ITERATIONS } from "./crypto.js";
import { call, callWith, configure } from "./tg.js";
import { setTopics, DEFAULT_CHAT } from "./config.js";
import { kv } from "./kv.js";

const VAULT = "tdw.auth.v1";
const SESSION = "tdw.session.v1";

let rawKey = null;
let creds = null;
let fails = 0;
let lockedUntil = 0;

export const isProvisioned = () => !!kv.get(VAULT);
export const isUnlocked = () => !!creds;
export const getCreds = () => creds;
export const getChat = () => creds?.chat || "";

export function lock() {
  rawKey = null; creds = null;
  sessionStorage.removeItem(SESSION);
}

// Non-secret wizard inputs, so a returning user is not forced to retype them.
export function lastInputs() {
  try { return JSON.parse(kv.get("tdw.inputs") || "{}"); } catch { return {}; }
}
function saveInputs(o) { kv.set("tdw.inputs", JSON.stringify(o)); }

// Verify the Telegram side BEFORE sealing it behind the password.
// Short per-attempt timeout: a blackholed connect must fail fast enough that the
// setup button never looks dead (4 × 8 s worst case, then a clear error).
async function probe({ token, dmUser }) {
  await callWith(token, "getMe", {}, { timeoutMs: 8000 });
  if (dmUser) await callWith(token, "sendChatAction", { chat_id: String(dmUser), action: "typing" }, { timeoutMs: 8000 });
}

function parseTp(tp) {
  const parts = String(tp || "").split(",").map((x) => parseInt(x.trim(), 10)).filter(Number.isInteger);
  if (!parts.length) return null;
  if (parts.length !== 7) throw new Error("Topic ID harus 7 angka: storage,backup,recycle,m0,m1,m2,m3");
  const [storage, backup, recycle, ...mappers] = parts;
  return { storage, backup, recycle, mappers };
}

// First run: validate, encrypt, unlock.
export async function provision(input, password) {
  if (password.length < 8) throw new Error("Password minimal 8 karakter");
  parseTp(input.tp); // validates before anything is written
  await probe(input);
  const salt = newSalt();
  const raw = await deriveRaw(password, salt);
  const data = { ...input, dmUser: String(input.dmUser), chat: input.chat || DEFAULT_CHAT };
  const blob = await encryptJSON(raw, data);
  kv.set(VAULT, JSON.stringify({ v: 1, salt, iter: ITERATIONS, ...blob }));
  saveInputs({ chat: data.chat, tp: input.tp || "" });
  return arm(raw, data);
}

export async function unlock(password) {
  const rec = JSON.parse(kv.get(VAULT) || "null");
  if (!rec) throw new Error("Belum di-setup");
  if (Date.now() < lockedUntil) {
    throw new Error(`Terlalu banyak percobaan. Tunggu ${Math.ceil((lockedUntil - Date.now()) / 1000)} detik.`);
  }
  const raw = await deriveRaw(password, rec.salt, rec.iter);
  let data;
  try {
    data = await decryptJSON(raw, rec);
  } catch {
    fails += 1;
    // exponential backoff window, self-expiring (never a permanent lockout)
    if (fails >= 3) lockedUntil = Date.now() + Math.min(2 ** (fails - 2) * 5, 60) * 1000;
    throw new Error(fails >= 3
      ? `Password salah. Tunggu ${Math.ceil((lockedUntil - Date.now()) / 1000)} detik sebelum coba lagi.`
      : "Password salah");
  }
  return arm(raw, data);
}

function arm(raw, data) {
  rawKey = raw;
  creds = data;
  fails = 0;
  lockedUntil = 0;
  sessionStorage.setItem(SESSION, raw);
  applyTransport();
  return true;
}

export function applyTransport() {
  if (!creds) return;
  const t = parseTp(creds.tp) || {};
  setTopics({ chat: creds.chat, storage: t.storage, backup: t.backup, recycle: t.recycle, mappers: t.mappers });
  configure({
    token: creds.token, worker: creds.worker || "", chat: creds.chat, dmUser: creds.dmUser,
  });
}

// Page load: reuse the tab-scoped key instead of re-prompting.
export async function boot() {
  const snap = sessionStorage.getItem(SESSION);
  if (!snap || !isProvisioned()) return { provisioned: isProvisioned(), unlocked: false };
  const rec = JSON.parse(kv.get(VAULT));
  try {
    const data = await decryptJSON(snap, rec); // verifies the vault still matches
    return arm(snap, data), { provisioned: true, unlocked: true };
  } catch {
    sessionStorage.removeItem(SESSION);
    return { provisioned: true, unlocked: false };
  }
}

// Change stored settings (topics/worker) — same password, re-encrypted.
export async function update(next) {
  if (!isUnlocked()) throw new Error("Terkunci");
  const rec = JSON.parse(kv.get(VAULT));
  creds = { ...creds, ...next };
  const blob = await encryptJSON(rawKey, creds);
  kv.set(VAULT, JSON.stringify({ v: 1, salt: rec.salt, iter: rec.iter, ...blob }));
  applyTransport();
  saveInputs({ chat: creds.chat, tp: creds.tp || "" });
}

// Rotate the password without re-entering the token.
export async function changePassword(oldPw, newPw) {
  if (newPw.length < 8) throw new Error("Password baru minimal 8 karakter");
  const rec = JSON.parse(kv.get(VAULT));
  const oldRaw = await deriveRaw(oldPw, rec.salt, rec.iter);
  const data = await decryptJSON(oldRaw, rec).catch(() => { throw new Error("Password lama salah"); });
  const salt = newSalt();
  const raw = await deriveRaw(newPw, salt);
  const blob = await encryptJSON(raw, data);
  kv.set(VAULT, JSON.stringify({ v: 1, salt, iter: ITERATIONS, ...blob }));
  sessionStorage.setItem(SESSION, raw);
  rawKey = raw;
  return true;
}

// Forget this browser only; the Telegram drive is untouched.
export function wipeLocal() {
  lock();
  kv.del(VAULT);
  kv.del("tdw.inputs");
}
