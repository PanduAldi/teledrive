# TeleDrive Web

Cloud drive ala TeleDrive: **React + Vite, murni static** (Netlify/Vercel gratis).
Tanpa backend — **Telegram yang jadi database + object storage** via Bot API,
dilindungi **password terenkripsi** di browser.

## Keamanan (login)

- First run: isi token + User ID + chat/topic → diverifikasi ke Telegram → **set password**.
  Kredensial disimpan sebagai blob **AES-GCM-256** dengan kunci **PBKDF2-SHA256 600.000 iterasi**.
  localStorage hanya berisi `{salt, iv, ciphertext}` — tidak ada token polos, tidak ada hash password.
- Tiap kunjungan: layar kunci → password benar = AES-GCM berhasil didekripsi.
- **Auto-lock 10 menit idle**, tombol 🔒 kunci manual, sesi bertahan saat refresh (hilang saat tab ditutup).
- Lupa password = tidak ada pemulihan (by design). Reset kredensial lokal → setup ulang token yang sama.
- Backoff eksponensial setelah 3 password salah; ganti password tersedia di ⚙️.

## Cara kerja (semua jalur diverifikasi ke Bot API live, Okt 2026)

| Kebutuhan | Solusi |
|---|---|
| Indeks pohon folder | 4 pesan JSON (shard) di 4 topic `index-*`; satu edit = satu mutasi |
| Byte file | dokumen di topic `storage`; chunk 19 MB (direct) / 45 MB (Worker) |
| Baca indeks dari device lain | `forwardMessage` ke DM user → baca isi → copy langsung dihapus |
| Hapus permanen | `deleteMessage` pesan indeks & dokumen |
| Preview/download | URL `api.telegram.org/file/...` via tag native `<img>/<video>/<a>` |
| Kredensial | blob terenkripsi di localStorage; token tak pernah plaintext |

**Batas Bot API** (terukur): upload ≤ 50 MB/call, download (getFile) ≤ 20 MB.
→ Mode tanpa Worker: **20 MB/file**. Dengan **Cloudflare Worker** (folder `worker/`,
secret `BOT_TOKEN`): **tanpa batas ukuran file** — chunk 45 MB di-stitch di browser + CORS.

## Setup

1. @BotFather → `/newbot` → salin **token**.
2. Buat grup Telegram (privat) → aktifkan **Topics** → jadikan supergroup →
   tambahkan bot sebagai **admin** (izin Delete messages + Manage topics wajib).
3. Buat 7 topic di grup (nama bebas): 4 untuk `index`, 1 `index-backup`,
   1 `recycle`, 1 `storage`. Catat 7 thread ID-nya (angka di URL topic):
   urutan input: `storage,backup,recycle,m0,m1,m2,m3`.
4. Dari akunmu: tekan **Start** di chat bot (izin DM), ambil **User ID** lewat @userinfobot.
5. Deploy:
   ```bash
   npm i && npm run build     # dist/
   # Netlify: import repo dari GitHub (build cmd & publish dir terdeteksi otomatis)
   # atau: vercel --prod
   ```
6. Buka app → isi semua field + password → **Simpan & buka drive**.

Semua ID di atas bisa diubah kapan pun dari ⚙️ Settings (bisa nempel ke grup/bot lain).

## Opsional tapi disarankan: Cloudflare Worker (bebas batas 20 MB)

1. dash.cloudflare.com → Workers → Create Worker → paste isi `worker/worker.js`
2. Settings → Variables → **Add secret**: `BOT_TOKEN` = token bot-mu
3. Salin URL `*.workers.dev` → tempel di ⚙️ Settings app → Simpan.

Mode Worker juga menghilangkan token dari browser (tinggal di Worker) dan
mengaktifkan download berprogress untuk file multi-chunk.

## Menjalankan lokal

```bash
npm i
npm run dev                 # http://localhost:5173
node scripts/test-e2e.mjs   # smoke test layer penyimpanan (butuh token di .env Hermes)
```

## Struktur

```
src/api/crypto.js   PBKDF2 + AES-GCM helpers (WebCrypto)
src/api/auth.js     vault: provision/unlock/changePassword/lock + backoff
src/api/tg.js       transport Bot API + retry (blackhole-connect & 429 retry_after)
src/api/store.js    indeks sharded + registry + backup
src/api/fs.js       operasi pohon: mkdir, rename, move, trash, purge, emptyBin
src/api/upload.js   chunked upload + download (direct & Worker mode)
src/api/config.js   chat + topic ids (runtime-configurable)
worker/worker.js    proxy Cloudflare opsional (CORS pada /file/, token di secret)
```

## Skema data

```json
// shard (pesan text JSON di topic index-N)
{ "v": 1, "i": 0, "seq": 42, "nodes": {
    "ab12cd34": { "id": "ab12cd34", "k": "d", "n": "Foto", "p": "", "c": ["ef56"], "ts": 1760000000000 },
    "ef56gh78": { "id": "ef56gh78", "k": "f", "n": "a.jpg", "s": 812345, "t": "image/jpeg",
                  "p": "ab12cd34", "mid": 123, "ts": 1760000001000 }
} }
// caption dokumen storage: {"i":0,"n":1,"name":"a.jpg"}   (chunk ke-0 dari 1)
```

## Batas

- 1 grup = 1 drive; kehilangan akses grup = kehilangan drive.
- `localStorage` hilang (clear browser) = setup ulang; drive di Telegram tetap aman.
- Preview hanya untuk file single-chunk; file multi-chunk lewat Download.
- Mutasi indeks = edit pesan yang sama, jadi chat tidak spam; hanya chunk file menambah pesan.
