// Settings + onboarding. Token stays on this device (localStorage).
// Chat id: the storage chat is fixed (JARVIS STATION forum). DM user id is
// discovered from getMe → getChat on first connect (Settings flow) and stored.

import { configure, call } from "./tg.js";
import { loadSettings, saveSettings, DEFAULT_CHAT } from "./config.js";
import { kv } from "./kv.js";

const DM_KEY = "tdw.dmuser.v1";

export async function connect(token, dmUserId) {
  // probe: any failure here (invalid token, network) bubbles to the UI
  const me = await callWith(token, "getMe");
  const settings = { token, worker: "", chat: DEFAULT_CHAT };
  saveSettings(settings);
  configure({ token, chat: DEFAULT_CHAT });
  if (dmUserId) await bindDmUser(dmUserId);
  return me; // { id, username, ... }
}

function callWith(token, method, fields) {
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(Object.entries(fields || {}).map(([k, v]) => [k, String(v)])),
  }).then((r) => r.json()).then((d) => {
    if (!d.ok) throw new Error(d.description || "Telegram error");
    return d.result;
  });
}

export async function bindDmUser(userId) {
  // The bot must be able to DM this user (user has pressed Start at least once,
  // or is a group member the bot already shares a chat with).
  await callWith(loadSettings().token, "sendChatAction", { chat_id: String(userId), action: "typing" });
  kv.set(DM_KEY, String(userId));
  configure(loadSettings());
  return String(userId);
}

export function getDmUser() { return kv.get(DM_KEY) || ""; }

export function boot() {
  const s = loadSettings();
  if (s?.token) configure({ ...s, dmUser: getDmUser() });
  return s;
}
