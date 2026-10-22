# TeleDrive Web

Cloud drive ala TeleDrive: **React + Vite, murni static** di Vercel.
Backend-nya tidak ada — **Telegram yang jadi database + object storage** via Bot API.

## Cara kerja (semua jalur sudah diverifikasi terhadap Bot API live, Okt 2026)

| Kebutuhan | Solusi |
|---|---|
| Metadata (pohon folder, indeks) | 4 pesan JSON (shard) di 4 topic `index-*`, satu edit = satu mutasi |
| Byte file | dokumen di topic `storage`, chunk 19 MB, metadata di caption |
| Baca index dari device mana pun | `forwardMessage` ke DM user → bot bisa baca isi lengkapnya → copy dihapus |
| Replace/edit file | `editMessageText` pada pesan shard |
| Delete permanen | `deleteMessage` pada pesan shard & dokumen |
| Download/preview | URL `api.telegram.org/file/bot…` via `<img>/<video>/<a download>` native |
| Token | hanya di localStorage browser + Cloudflare Worker secret (opsional) |

**Batas Bot API** (terukur, bukan dokumen): upload ≤ 50 MB per call, **getFile ≤ 20 MB**
→ mode tanpa Worker dibatasi 20 MB/file. Pasang Cloudflare Worker (folder `worker/`)
agar bebas batas + download berprogress.

> Sebelum connect, siapkan **User ID Telegram kamu** (lihat @userinfobot) dan tekan
> **Start** di chat bot. Bot memakai DM kamu sebagai jalur baca indeks
> (`forwardMessage` → baca → hapus) karena Bot API tidak punya "getMessages".

## Setup (yGTG paling singkat)

1. **Buat bot**: chat @BotFather → `/newbot` → salin token.
2. **Grup penyimpanan**: grup Telegram (disarankan grup privat) → jadikan supergroup+topics →
   tambahkan bot sebagai admin (izin delete messages).
   Salin `src/api/config.js`: isi `MAPPERS`, `BACKUP_TOPIC`, `RECYCLE_TOPIC`, `STORAGE_TOPIC`,
   `DEFAULT_CHAT` dengan thread id topic kamu (lihat angka di `t.me/c/<chat>/<topic>`).
3. **DM user**: kirim `/start` ke bot dari akunmu (untuk baca index).
4. **Deploy Vercel**:
   ```bash
   npm i
   npm run build         # dist/
   vercel --prod         # atau import repo di vercel.com
   ```
5. Buka app → Settings → tempel token → selesai. Semua data milik grup Telegram-mu.

## Opsional: Worker (buka batas 20 MB)

`worker/worker.js` → deploy ke Cloudflare Workers (secret `BOT_TOKEN`) →
tempel URL-nya di Settings. Pada mode ini token tidak pernah dikirim ke browser.

## Skema data

```json
// shard (pesan text JSON di topic index-N)
{ "v": 1, "i": 0, "seq": 42, "nodes": {
    "ab12cd34": { "id": "ab12cd34", "k": "d", "n": "Foto", "p": "", "c": ["ef56"], "ts": 1760000000000 },
    "ef56gh78": { "id": "ef56gh78", "k": "f", "n": "a.jpg", "s": 812345, "t": "image/jpeg",
                  "p": "ab12cd34", "mid": 123, "ts": 1760000001000 }
} }
// caption dokumen storage: {"i":0,"n":1,"name":"a.jpg"}  (ke-0 dari 1 chunk)
```

## Menjalankan lokal

```bash
npm i
npm run dev          # http://localhost:5173
node scripts/test-e2e.mjs   # smoke test layer API (butuh token di env)
```

## Batas & catatan

- 1 grup = 1 drive. Mau multi-user? grit grup lain + topic set sendiri.
- Topic 4 mapper dipakai agar edit-message 4096 char tetap lega; pembagian by-hash stabil antar device.
- Kehilangan localStorage = hubungkan ulang via message link backup (restore manual, lihat topic `index-backup`).
- Chat spam tidak terjadi: mutasi = edit pesan yang sama; hanya chunk file yang menambah pesan.
