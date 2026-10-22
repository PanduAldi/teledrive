import { useState, useEffect, useCallback, useRef } from "react";
import * as fs from "./api/fs.js";
import * as cfg from "./api/config.js";
import * as settings from "./api/settings.js";
import { uploadFile, urlForFile, triggerDownload, DIRECT_MAX } from "./api/upload.js";
import { readMessage } from "./api/tg.js";

const fmt = (b) => {
  if (!b && b !== 0) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
};
const kindOf = (n) =>
  n.k === "d" ? "folder"
  : (n.t || "").startsWith("image/") ? "image"
  : (n.t || "").startsWith("video/") ? "video"
  : (n.t || "").startsWith("audio/") ? "audio"
  : (n.t || "").includes("pdf") ? "pdf" : "file";
const ICON = { folder: "📁", image: "🖼️", video: "🎬", audio: "🎵", pdf: "📕", file: "📄" };

export default function App() {
  const [ready, setReady] = useState(false);
  const [me, setMe] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [dir, setDir] = useState("");
  const [tick, setTick] = useState(0);
  const [view, setView] = useState("grid");
  const [q, setQ] = useState("");
  const [preview, setPreview] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState("");
  const dragRef = useRef(false);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // ── boot ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const s = settings.boot();
    (async () => {
      if (!s?.token) return setReady(true);
      try {
        const m = await (await import("./api/tg.js")).call("getMe");
        setMe(m);
        await fs.init();
        refresh();
      } catch (e) { setErr(e.message); }
      setReady(true);
    })();
  }, [refresh]);

  async function doConnect(token, dmUserId) {
    setErr("");
    try {
      setBusy("Menghubungkan…");
      const m = await settings.connect(token, dmUserId);
      setMe(m);
      await fs.init();
      refresh();
      setSettingsOpen(false);
    } catch (e) { setErr(e.message); }
    setBusy("");
  }

  // ── navigation ─────────────────────────────────────────────────────────
  const nodes = fs.getNodes();
  const cwd = dir === "recycle" ? "recycle" : dir;
  const items = fs.childrenOf(cwd).sort((a, b) =>
    (a.k === b.k ? a.n.localeCompare(b.n) : a.k === "d" ? -1 : 1));
  const filtered = q
    ? Object.values(nodes).filter((n) => n.n.toLowerCase().includes(q.toLowerCase()))
    : items;
  const trail = dir && dir !== "recycle" ? fs.pathOf(dir) : [];

  // ── actions ────────────────────────────────────────────────────────────
  async function withBusy(label, fn) {
    setBusy(label); setErr("");
    try { await fn(); refresh(); }
    catch (e) { setErr(e.message); }
    setBusy("");
  }

  const onFiles = async (fileList) => {
    const files = [...fileList];
    if (!files.length) return;
    await withBusy(`Upload ${files.length} file…`, async () => {
      let done = 0;
      for (const f of files) {
        setBusy(`Upload ${++done}/${files.length}: ${f.name}`);
        const up = await uploadFile(f, null, !!cfg.loadSettings().worker);
        await fs.addFile({
          name: f.name, size: f.size, type: f.type,
          mid: up.mid, chMids: up.chMids, chunks: up.ch,
          parent: dir === "recycle" ? "" : dir,
        });
      }
      setToast(`${files.length} file terunggah`);
    });
  };

  const onDownload = async (n) => {
    await withBusy(`Menyiapkan ${n.n}…`, async () => {
      const { url } = await urlForFile(n);
      triggerDownload(url, n.n);
    });
  };

  const openPreview = async (n) => {
    if (n.k === "d") return setDir(n.id);
    if (n.k === "f" && n.mid) {
      await withBusy("Memuat preview…", async () => {
        const { url } = await urlForFile(n);
        setPreview({ node: n, url });
      });
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    dragRef.current = false;
    if (e.dataTransfer?.files?.length) onFiles(e.dataTransfer.files);
  };

  const shareUrl = (n) => `${location.origin}${location.pathname}?f=${n.id}`;

  // ── screens ────────────────────────────────────────────────────────────
  if (!ready) return <div className="center muted">Memuat…</div>;

  if (!me) {
    return (
      <div className="center">
        <div className="card">
          <h1>TeleDrive Web</h1>
          <p className="muted">
            Cloud drive tanpa server — file disimpan di Telegram, app-nya statis di Vercel.
          </p>
          <Connect token={cfg.loadSettings().token} onConnect={doConnect} />
          {err && <p className="err">{err}</p>}
          {busy && <p className="muted">{busy}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="app" onDragOver={(e) => { e.preventDefault(); dragRef.current = true; }}
         onDrop={onDrop}>
      <header>
        <div className="logo" onClick={() => setDir("")}>📦 TeleDrive</div>
        <input className="search" placeholder="Cari file…" value={q}
               onChange={(e) => setQ(e.target.value)} />
        <div className="tools">
          <button onClick={() => setView(view === "grid" ? "list" : "grid")}>
            {view === "grid" ? "☰" : "▦"}
          </button>
          <button onClick={() => setDir("recycle")}>🗑️</button>
          <button className="primary"
            onClick={() => withBusy("Membuat folder…", () => fs.createFolder(prompt("Nama folder?") || "Folder", dir === "recycle" ? "" : dir))}>
            + Folder
          </button>
          <button onClick={() => setSettingsOpen(true)}>⚙️</button>
        </div>
      </header>

      {busy && <div className="bar">{busy}</div>}
      {toast && <div className="toast" onClick={() => setToast("")}>{toast}</div>}
      {err && <div className="errbar" onClick={() => setErr("")}>{err} <b>×</b></div>}

      <nav className="crumbs">
        <span onClick={() => setDir("")}>Beranda</span>
        {trail.map((t) => (
          <span key={t.id}> / <b onClick={() => setDir(t.id)}>{t.n}</b></span>
        ))}
        {dir === "recycle" && <span> / 🗑️ Sampah</span>}
      </nav>

      <main className={view}>
        {filtered.length === 0 && (
          <div className="empty">
            <p>{q ? "Tidak ada hasil." : dir === "recycle" ? "Sampah kosong." : "Belum ada file."}</p>
            {!q && dir !== "recycle" && <label className="btnfile">
              Pilih file<input type="file" multiple hidden onChange={(e) => onFiles(e.target.files)} /></label>}
          </div>
        )}
        {filtered.map((n) => (
          <div className="item" key={n.id}>
            <div className="icon" onClick={() => openPreview(n)}>
              {kindOf(n) === "image"
                ? <Thumb node={n} />
                : <span className="emoji">{ICON[kindOf(n)]}</span>}
            </div>
            <div className="meta" onClick={() => openPreview(n)}>
              <div className="name">{n.n}</div>
              <div className="sub">
                {n.k === "d"
                  ? `${n.c?.length || 0} item`
                  : fmt(n.s)}
                {" · "}{new Date(n.ts).toLocaleDateString("id-ID")}
              </div>
            </div>
            <div className="acts">
              {n.k === "f" && <button title="Download" onClick={() => onDownload(n)}>⬇️</button>}
              {dir === "recycle" ? (
                <>
                  <button title="Pulihkan"
                    onClick={() => withBusy("Memulihkan…", () => fs.restore(n.id))}>♻️</button>
                  <button title="Hapus permanen"
                    onClick={() => confirm(`Hapus "${n.n}" selamanya? Ini tidak bisa dibatalkan.`)
                      && withBusy("Menghapus…", () => fs.purge(n.id))}>❌</button>
                </>
              ) : (
                <>
                  <button title="Share" onClick={() => {
                    navigator.clipboard?.writeText(shareUrl(n));
                    setToast("Link disalin (penerima butuh token bot sendiri)");
                  }}>🔗</button>
                  <button title="Rename"
                    onClick={() => { const v = prompt("Nama baru", n.n); if (v) withBusy("…", () => fs.rename(n.id, v)); }}>✏️</button>
                  <button title="Sampah" onClick={() => withBusy("…", () => fs.trash(n.id))}>🗑️</button>
                </>
              )}
            </div>
          </div>
        ))}
        {dir === "recycle" && filtered.length > 0 && (
          <button className="danger full"
            onClick={() => confirm("Kosongkan sampah? File akan dihapus permanen dari Telegram.")
              && withBusy("Mengosongkan…", () => fs.emptyBin())}>
            Kosongkan sampah (permanen)
          </button>
        )}
      </main>

      <Drop hint={dragRef.current} />

      {preview && <Preview {...preview} onClose={() => setPreview(null)} onDownload={onDownload} />}
      {settingsOpen && (
        <Settings me={me} onClose={() => setSettingsOpen(false)} onSaved={() => { refresh(); setToast("Tersimpan"); }} />
      )}
    </div>
  );
}

function Thumb({ node }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let dead = false;
    if (!node.mid) return;
    urlForFile(node).then(({ url }) => !dead && setUrl(url)).catch(() => {});
    return () => { dead = true; };
  }, [node.id]);
  return url ? <img src={url} alt={node.n} loading="lazy" /> : <span className="emoji">🖼️</span>;
}

function Connect({ token, onConnect }) {
  const [v, setV] = useState(token || "");
  const [uid, setUid] = useState("");
  return (
    <>
      <label>
        Bot token (dari @BotFather)
        <input value={v} onChange={(e) => setV(e.target.value)}
               placeholder="123456:ABC-DEF…" autoComplete="off" spellCheck={false} />
      </label>
      <label>
        User ID Telegram kamu <span className="muted">(untuk membaca indeks lewat DM)</span>
        <input value={uid} onChange={(e) => setUid(e.target.value.replace(/\D/g, ""))}
               placeholder="100200300" inputMode="numeric" autoComplete="off" />
      </label>
      <button className="primary wide" disabled={!v.trim() || !v.includes(":") || !uid.trim()}
              onClick={() => onConnect(v.trim(), uid.trim())}>
        Hubungkan
      </button>
      <p className="muted small">
        Token & ID hanya tersimpan di browser ini. Syarat: bot sudah admin grup penyimpanan,
        dan kamu sudah menekan <b>Start</b> di chat bot (= izin DM dari kamu).
        Lihat ID kamu lewat @userinfobot.
      </p>
    </>
  );
}

function Preview({ node, url, onClose, onDownload }) {
  const k = kindOf(node);
  return (
    <div className="modal" onClick={onClose}>
      <div className="modalbox" onClick={(e) => e.stopPropagation()}>
        <div className="modalhead">
          <b>{node.n}</b>
          <span>
            <button onClick={() => onDownload(node)}>⬇️ Download</button>
            <button onClick={onClose}>✕</button>
          </span>
        </div>
        <div className="modalbody">
          {k === "image" && <img src={url} alt={node.n} />}
          {k === "video" && <video src={url} controls playsInline preload="metadata" />}
          {k === "audio" && <audio src={url} controls />}
          {k === "pdf" && <iframe src={url} title={node.n} />}
          {k === "file" && (
            <p className="muted">
              Pratinjau tidak tersedia untuk tipe ini. Gunakan Download
              {" "}({fmt(node.s)}).
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function Settings({ me, onClose, onSaved }) {
  const s = cfg.loadSettings();
  const [token, setToken] = useState(s.token || "");
  const [worker, setWorker] = useState(s.worker || "");
  const [dm, setDm] = useState(settings.getDmUser());
  const [chat, setChat] = useState(s.chat || cfg.topics.chat);
  const [tp, setTp] = useState(
    s.tp || [cfg.topics.storage, cfg.topics.backup, cfg.topics.recycle, ...cfg.topics.mappers].join(",")
  );
  const [msg, setMsg] = useState("");
  return (
    <div className="modal" onClick={onClose}>
      <div className="modalbox" onClick={(e) => e.stopPropagation()}>
        <div className="modalhead"><b>Pengaturan</b><button onClick={onClose}>✕</button></div>
        <div className="modalbody form">
          <label>Bot token
            <input value={token} onChange={(e) => setToken(e.target.value)} spellCheck={false} />
          </label>
          <label>Cloudflare Worker URL <span className="muted">(opsional — buka batas 20 MB)</span>
            <input value={worker} onChange={(e) => setWorker(e.target.value)}
                   placeholder="https://teledrive-proxy.xxx.workers.dev" spellCheck={false} />
          </label>
          <label>Telegram user id (untuk baca index)
            <input value={dm} onChange={(e) => setDm(e.target.value)} placeholder={String(me.id)} />
          </label>
          <label>Chat ID grup penyimpanan
            <input value={chat} onChange={(e) => setChat(e.target.value)}
                   placeholder="-100…" spellCheck={false} />
          </label>
          <label>Topic ID <span className="muted">(storage, backup, recycle, dipisah koma untuk 4 mapper:
            <i> storage,backup,recycle,m0,m1,m2,m3</i>)</span>
            <input value={tp} onChange={(e) => setTp(e.target.value)}
                   placeholder="61,59,60,55,56,57,58" spellCheck={false} />
          </label>
          <button className="primary wide" onClick={async () => {
            try {
              const parts = tp.split(",").map((x) => parseInt(x.trim(), 10)).filter((x) => Number.isInteger(x));
              if (parts.length && parts.length !== 7) throw new Error("Topic ID harus 7 angka: storage,backup,recycle,m0,m1,m2,m3");
              const [storage, backup, recycle, ...mappers] = parts;
              cfg.saveSettings({ ...s, token, worker, chat, tp: parts.length ? tp : "" });
              const { configure } = await import("./api/tg.js");
              configure({ token, worker, chat: chat || cfg.DEFAULT_CHAT, dmUser: dm });
              cfg.setTopics({ chat, storage, backup, recycle, mappers });
              if (dm) await settings.bindDmUser(dm);
              onSaved();
            } catch (e) { setMsg(e.message); }
          }}>Simpan</button>
          {msg && <p className="err">{msg}</p>}
          <p className="muted small">
            Terhubung sebagai @{me.username || me.first_name}.
            Penyimpanan: grup Telegram (topic storage {cfg.topics.storage}).
            Batas {fmt(DIRECT_MAX)}/file tanpa Worker.
          </p>
        </div>
      </div>
    </div>
  );
}

function Drop({ hint }) { return hint ? <div className="drop">Lepaskan file di sini</div> : null; }
