// Topic ids of JARVIS STATION forum (created 2026-10-22, verified via Bot API).
export const MAPPERS = [55, 56, 57, 58];
export const BACKUP_TOPIC = 59;
export const RECYCLE_TOPIC = 60;
export const STORAGE_TOPIC = 61;

export const DEFAULT_CHAT = "-1003539953822";

// Settings persistence (localStorage; token never leaves the browser device)
const SKEY = "tdw.settings.v1";
export function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SKEY)) || {}; } catch { return {}; }
}
export function saveSettings(s) { localStorage.setItem(SKEY, JSON.stringify(s)); }
