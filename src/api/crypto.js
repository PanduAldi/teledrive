// Password-based credential encryption (WebCrypto, zero dependencies).
//
// Design: PBKDF2-SHA256(600k) → 32 raw bytes → AES-GCM-256. We keep the RAW key
// bytes (not a non-extractable CryptoKey handle) because the tab-scoped session
// snapshot needs to survive a page refresh without ever writing plaintext.
// The raw key lives only in sessionStorage (cleared when the tab closes).
//
// What this defends against (static app, no server):
//  - Reading localStorage gets you {salt, iv, ct} only. Without the password there
//    is nothing to test guesses against except AES-GCM's authentication tag, and
//    each guess costs 600k PBKDF2 iterations.
//  - The Telegram token is never stored in plaintext anywhere.
// What it cannot defend against: a live compromised session while unlocked.

const enc = new TextEncoder();
const dec = new TextDecoder();
export const ITERATIONS = 600_000;

const b64enc = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64dec = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function newSalt() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return b64enc(a);
}

// Returns the raw 32-byte key material, base64.
export async function deriveRaw(password, salt, iterations = ITERATIONS) {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: b64dec(salt), iterations, hash: "SHA-256" },
    base,
    256
  );
  return b64enc(bits);
}

async function aesKey(rawB64, usage) {
  return crypto.subtle.importKey("raw", b64dec(rawB64), { name: "AES-GCM" }, false, [usage]);
}

export async function encryptJSON(rawB64, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await aesKey(rawB64, "encrypt"),
    enc.encode(JSON.stringify(obj))
  );
  return { iv: b64enc(iv), ct: b64enc(ct) };
}

// Throws (OperationError) when the password is wrong — GCM tag mismatch.
export async function decryptJSON(rawB64, { iv, ct }) {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64dec(iv) },
    await aesKey(rawB64, "decrypt"),
    b64dec(ct)
  );
  return JSON.parse(dec.decode(pt));
}
