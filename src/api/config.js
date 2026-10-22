// Storage targets. Defaults point at the JARVIS STATION forum this project was
// built against; override chat + topics in Settings so your own bot + your own
// Telegram group can back this drive (topics are just thread ids).
export const topics = {
  chat: "-1003539953822",
  mappers: [55, 56, 57, 58],
  backup: 59,
  recycle: 60,
  storage: 61,
};

export function setTopics({ chat, mappers, backup, recycle, storage } = {}) {
  if (chat) topics.chat = chat;
  if (Array.isArray(mappers) && mappers.length) topics.mappers = mappers;
  if (backup) topics.backup = Number(backup);
  if (recycle) topics.recycle = Number(recycle);
  if (storage) topics.storage = Number(storage);
}

export const DEFAULT_CHAT = topics.chat;

// Settings persistence (localStorage; token never leaves the browser device)
const SKEY = "tdw.settings.v1";
export function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SKEY)) || {}; } catch { return {}; }
}
export function saveSettings(s) { localStorage.setItem(SKEY, JSON.stringify(s)); }
