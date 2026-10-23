import { useState, useEffect, useCallback, useRef } from "react";
import * as fs from "./api/fs.js";
import * as cfg from "./api/config.js";
import * as auth from "./api/auth.js";
import { uploadFile, urlForFile, triggerDownload, downloadMultiChunk, DIRECT_MAX } from "./api/upload.js";
import { call } from "./api/tg.js";

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
const IDLE_LOCK_MS = 10 * 60 * 1000; // auto-lock after 10 idle minutes

export default function App() {
  const [gate, setGate] = useState("loading"); // loading|setup|locked|open
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
  const idleRef = useRef(Date.now());

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // ── gate: vault boot ────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const st = await auth.boot();
      setGate(st.unlocked ? "open" : st.provisioned ? "locked" : "setup");
    })();
  }, []);

  // once open: who am I + load the tree
  useEffect(() => {
    if (gate !== "open") return;
    (async () => {
      try {
        if (!me) setMe(await call("getMe"));
        await fs.init();
        refresh();
      } catch (e) { setErr(e.message); }
    })();
  }, [gate, me, refresh]);

  // ── auto-lock on idle ───────────────────────────────────────────────────
  useEffect(() => {
    if (gate !== "open") return;
    const bump = () => { idleRef.current = Date.now(); };
    for (const ev of ["pointerdown", "keydown", "wheel", "touchstart"]) {
      window.addEventListener(ev, bump, { passive: true });
    }
    const t = setInterval(() => {
      if (Date.now() - idleRef.current > IDLE_LOCK_MS) lockNow();
    }, 30_000);
    return () => {
      clearInterval(t);
      for (const ev of ["pointerdown", "keydown", "wheel", "touchstart"]) window.removeEventListener(ev, bump);
    };
  }, [gate]);

  function lockNow() {
    auth.lock();
    setMe(null);
    setPreview(null);
    setSettingsOpen(false);
    setDir("");
    setErr("");
    setGate(auth.isProvisioned() ? "locked" : "setup");
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
  const workerMode = !!auth.getCreds()?.worker;

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
        if (!workerMode && f.size > DIRECT_MAX) {
          // refuse BEFORE uploading bytes that could never be downloaded back
          throw new Error(
            `"${f.name}" ${fmt(f.size)} melebihi batas ${fmt(DIRECT_MAX)} Bot API. ` +
            `Pasang Cloudflare Worker URL di ⚙️ agar file besar tanpa batas, atau pilih file lebih kecil.`
          );
        }
        setBusy(`Upload ${++done}/${files.length}: ${f.name}`);
        const up = await uploadFile(f, null, workerMode);
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
      const w = auth.getCreds()?.worker;
      if (w && (n.chMids?.length > 1 || (n.s || 0) > DIRECT_MAX)) {
        await downloadMultiChunk(n, w); // reassembled in-browser through the Worker
      } else {
        const { url } = await urlForFile(n);
        triggerDownload(url, n.n);
      }
    });
  };

  const openPreview = async (n) => {
    if (n.k === "d") return setDir(n.id);
    if (n.k !== "f") return;
    if (n.chMids?.length > 1) {
      return setToast(`"${n.n}" tersimpan sebagai ${n.chMids.length} bagian — pakai ⬇️ Download`);
    }
    if (n.mid) {
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

  // ── screens ────────────────────────────────────────────────────────────
  if (gate === "loading") return <div className="center muted">Memuat…</div>;

  if (gate === "setup") {
    return (
      <div className="center">
        <div className="card">
          <h1>TeleDrive Web</h1>
          <p className="muted">
            Sekali setup: token + data diverifikasi ke Telegram, lalu dikunci password.
          </p>
          <Setup onDone={() => setGate("open")} />
        </div>
      </div>
    );
  }

  if (gate === "locked") {
    return (
      <div className="center">
        <div className="card">
          <h1>🔒 Terkunci</h1>
          <p className="muted">Masukkan password untuk membuka drive.</p>
          <Unlock onDone={() => setGate("open")} />
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
          <button onClick={() => setView(view === "grid" ? "list" : "grid")} title="Ganti tampilan">
            {view === "grid" ? "☰" : "▦"}
          </button>
          <button onClick={() => setDir("recycle")} title="Sampah">🗑️</button>
          <button className="primary"
            onClick={() => withBusy("Membuat folder…", () => fs.createFolder(prompt("Nama folder?") || "Folder", dir === "recycle" ? "" : dir))}>
            + Folder
          </button>
          <button onClick={() => setSettingsOpen(true)} title="Pengaturan">⚙️</button>
          <button onClick={lockNow} title="Kunci sekarang">🔒</button>
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
              {kindOf(n) === "image" && n.mid ? <Thumb node={n} /> : <span className="emoji">{ICON[kindOf(n)]}</span>}
            </div>
            <div className="meta" onClick={() => openPreview(n)}>
              <div className="name">{n.n}</div>
              <div className="sub">
                {n.k === "d" ? `${n.c?.length || 0} item` : fmt(n.s)}
                {n.chMids?.length > 1 && ` · ${n.chMids.length} bagian`}
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
                    navigator.clipboard?.writeText(`${location.origin}${location.pathname}?f=${n.id}`);
                    setToast("Link disalin (penerima butuh password + setup yang sama)");
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
        <Settings me={me} onClose={() => setSettingsOpen(false)}
                  onSaved={() => { refresh(); setToast("Tersimpan"); }} onLock={lockNow} />
      )}
    </div>
  );
}

// ── First-run wizard: verify the Telegram inputs, THEN seal them with a password ──
function Setup({ onDone }) {
  const prev = auth.lastInputs();
  const [token, setToken] = useState("");
  const [uid, setUid] = useState("");
  const [botUser, setBotUser] = useState(null);
  const [chat, setChat] = useState("");
  const [tp, setTp] = useState("auto");
  const [autoTps, setAutoTps] = useState(false);
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");

  const problems = [];
  if (!token.includes(":")) problems.push("Token belum valid (harusnya format `123456:ABC…` dari @BotFather)");
  if (!/^\d{5,}$/.test(uid.trim())) problems.push("User ID belum diisi (angka, ≥5 digit — lihat @userinfobot)");
  if (pw1.length < 8) problems.push("Password kurang dari 8 karakter");
  else if (pw1 !== pw2) problems.push("Password dan ulanginya tidak sama");
  const chatEmpty = !chat.trim() && tp !== "auto";
  if (chatEmpty) problems.push("Chat ID grup penyimpanan belum diisi");

  async function checkToken() {
    setErr(""); setBusy("Memeriksa token…");
    try {
      const { callWith } = await import("./api/tg.js");
      const me = await callWith(token.trim(), "getMe", {}, { timeoutMs: 8000 });
      setBotUser(`@${me.username}`);
      setErr("");
      return me;
    } catch (e) {
      setBotUser(null);
      setErr("✗ Token ditolak Telegram: " + e.message);
      return null;
    } finally { setBusy(""); }
  }

  // One click: add the bot to your group as admin, then this creates the 7 topics
  // and fills every id for you. Topic mode must already be ON in the group.
  async function autoTopics() {
    setErr(""); setBusy("Membuat 7 topic di grup…");
    try {
      const { createTopics } = await import("./api/auth.js");
      const { callWith } = await import("./api/tg.js");
      const chatId = chat.trim();
      const me = await callWith(token.trim(), "getChat", { chat_id: chatId }, { timeoutMs: 8000 });
      if (!me.is_forum) throw new Error("Grup belum aktif Topics-nya. Di grup: buka menu → Manage group → Toggle Topics ON, lalu coba lagi.");
      const r = await createTopics(token.trim(), chatId);
      setTp(r.tp);
      setAutoTps(true);
      setBusy("");
      setErr("");
      return r;
    } catch (e) { setBusy(""); setErr("✗ " + e.message); return null; }
  }

  async function submit() {
    setErr(""); setBusy("");
    if (problems.length) { setErr(problems[0]); return; }
    setBusy("Memverifikasi token & grup ke Telegram…");
    const tpVal = tp.trim() === "auto" ? prev.tp || "" : tp.trim();
    if (!tpVal) {
      setBusy("");
      setErr("Topic ID belum ada. Klik \"Buat 7 topic otomatis\" setelah mengisi Chat ID, atau isi manual 7 angka.");
      return;
    }
    try {
      const r = await auth.provision(
        { token: token.trim(), dmUser: uid.trim(), chat: chat.trim(), tp: tpVal },
        pw1
      );
      setBusy("Mengenkripsi & membuka drive…");
      onDone();
      return r;
    } catch (e) {
      setBusy("");
      setErr(/Failed to fetch|timeout|abort/i.test(e.message)
        ? "Koneksi ke Telegram gagal/timeout. Cek internet, lalu coba lagi."
        : e.message);
    }
  }

  return (
    <>
      <label>Bot token (dari @BotFather)
        <input value={token} onChange={(e) => setToken(e.target.value)}
               placeholder="123456:ABC-DEF…" autoComplete="off" spellCheck={false} onBlur={checkToken} />
      </label>
      {botUser && <p className="ok small">✓ Token valid — {botUser}</p>}
      <label>User ID Telegram kamu <span className="muted">(@userinfobot)</span>
        <input value={uid} onChange={(e) => setUid(e.target.value.replace(/\D/g, ""))}
               placeholder="100200300" inputMode="numeric" autoComplete="off" />
      </label>
      <label>Chat ID grup penyimpanan
        <input value={chat} onChange={(e) => setChat(e.target.value)} placeholder="-100…" spellCheck={false} />
      </label>
      <p className="muted small">
        Cara ambil: tambahkan bot ke grup (sebagai <b>admin</b>, izin <i>Manage topics</i> + <i>Delete messages</i>),
        aktifkan <b>Topics</b> di grup, lalu forward pesan grup ke @username_to_id_bot — atau pakai
        tombol di bawah kalau grup sudah bertopic.
      </p>
      <button className="wide" disabled={!token.includes(":") || !chat.trim() || !!busy} onClick={autoTopics}>
        Buat 7 topic otomatis
      </button>
      <label>Topic ID <span className="muted">kosongkan/"auto" untuk tombol otomatis, atau 7 angka:</span>
        <input value={tp} onChange={(e) => setTp(e.target.value)}
               placeholder="auto (disarankan)" spellCheck={false} />
      </label>
      <p className="muted small">Urutan manual: <i>storage,backup,recycle,m0,m1,m2,m3</i></p>
      <hr />
      <label>Password <span className="muted">(min 8 karakter — kunci enkripsi lokal, hilang = kredensial hilang)</span>
        <input type="password" value={pw1} onChange={(e) => setPw1(e.target.value)} autoComplete="new-password" />
      </label>
      <label>Ulangi password
        <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
      </label>
      {pw1 && pw2 && pw1 !== pw2 && <p className="err">Password tidak sama</p>}
      <button className="primary wide" disabled={!!busy} onClick={submit}>
        {busy ? busy : "Simpan & buka drive"}
      </button>
      {busy && <p className="muted">{busy}</p>}
      {err && <p className="err">{err}</p>}
      {!err && !busy && problems.length > 0 && (
        <p className="muted small">Belum lengkap: {problems.join(" · ")}</p>
      )}
      <p className="muted small">
        Token & ID dienkripsi (AES-GCM 256, kunci PBKDF2 600k iterasi) — hanya tersimpan di
        browser ini. Syarat: bot admin grup penyimpanan + kamu sudah <b>Start</b> di chat bot.
      </p>
    </>
  );
}

function Unlock({ onDone }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e?.preventDefault();
    setErr(""); setBusy(true);
    try { await auth.unlock(pw); onDone(); }
    catch (er) { setErr(er.message); setPw(""); }
    setBusy(false);
  }
  return (
    <form onSubmit={submit}>
      <label>Password
        <input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)}
               autoComplete="current-password" />
      </label>
      <button className="primary wide" type="submit" disabled={!pw || busy}>
        {busy ? "Membuka…" : "Buka"}
      </button>
      {err && <p className="err">{err}</p>}
      <p className="muted small">
        Lupa password? Tidak ada pemulihan — token sudah terenkripsi. Reset kredensial lokal
        di bawah, lalu setup ulang dengan token bot yang sama.
      </p>
      <button className="wide" type="button"
        onClick={() => { if (confirm("Lupakan kredensial tersimpan di browser ini? Drive di Telegram tidak terhapus.")) { auth.wipeLocal(); location.reload(); } }}>
        Reset kredensial lokal
      </button>
    </form>
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
            <p className="muted">Pratinjau tidak tersedia untuk tipe ini. Gunakan Download ({fmt(node.s)}).</p>
          )}
        </div>
      </div>
    </div>
  );
}

function Settings({ me, onClose, onSaved, onLock }) {
  const c = auth.getCreds() || {};
  const [worker, setWorker] = useState(c.worker || "");
  const [chat, setChat] = useState(c.chat || "");
  const [tp, setTp] = useState(c.tp || "");
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [pwMsg, setPwMsg] = useState("");
  const [pwErr, setPwErr] = useState("");
  const [pwBusy, setPwBusy] = useState("");
  const [saveBusy, setSaveBusy] = useState(false);

  return (
    <div className="modal" onClick={onClose}>
      <div className="modalbox" onClick={(e) => e.stopPropagation()}>
        <div className="modalhead"><b>Pengaturan</b><button onClick={onClose}>✕</button></div>
        <div className="modalbody form">
          <label>Cloudflare Worker URL <span className="muted">(kosong = mode langsung, batas {fmt(DIRECT_MAX)}/file)</span>
            <input value={worker} onChange={(e) => setWorker(e.target.value)}
                   placeholder="https://teledrive-proxy.xxx.workers.dev" spellCheck={false} />
          </label>
          <label>Chat ID grup penyimpanan
            <input value={chat} onChange={(e) => setChat(e.target.value)} placeholder="-100…" spellCheck={false} />
          </label>
          <label>Topic ID <span className="muted">7 angka: storage,backup,recycle,m0,m1,m2,m3</span>
            <input value={tp} onChange={(e) => setTp(e.target.value)} placeholder="61,59,60,55,56,57,58" spellCheck={false} />
          </label>
          <button className="primary wide" disabled={saveBusy} onClick={async () => {
            setErr(""); setMsg(""); setSaveBusy(true);
            try {
              await auth.update({ worker: worker.trim(), chat: chat.trim(), tp: tp.trim() });
              setMsg("✓ Tersimpan & terenkripsi ulang.");
              onSaved();
            } catch (e) { setErr("✗ " + e.message); }
            setSaveBusy(false);
          }}>{saveBusy ? "Menyimpan…" : "Simpan"}</button>
          {msg && <p className="ok small">{msg}</p>}
          {err && <p className="err">{err}</p>}

          <hr />
          <p className="muted small">Ganti password (token tidak perlu diinput ulang)</p>
          <label>Password lama
            <input type="password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} autoComplete="current-password" />
          </label>
          <label>Password baru (min 8)
            <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" />
          </label>
          <button className="wide" disabled={!!pwBusy || !oldPw || !newPw} onClick={async () => {
            setPwErr(""); setPwMsg("");
            const old = oldPw, nw = newPw;
            setPwBusy("Memverifikasi… (PBKDF2 600k, ±1-2 detik)");
            try {
              await auth.changePassword(old, nw);
              setPwBusy(""); setPwMsg("✓ Password diganti. Pakai password baru mulai sekarang.");
              setOldPw(""); setNewPw("");
            } catch (e) { setPwBusy(""); setPwErr("✗ " + e.message); }
          }}>{pwBusy ? pwBusy : "Ganti password"}</button>
          {pwMsg && <p className="ok small">{pwMsg}</p>}
          {pwErr && <p className="err">{pwErr}</p>}

          <hr />
          <button className="wide" onClick={onLock}>🔒 Kunci sekarang</button>
          <button className="danger wide" onClick={() => {
            if (confirm("Lupakan kredensial di browser ini? Drive di Telegram TIDAK terhapus.")) {
              auth.wipeLocal(); location.reload();
            }
          }}>Reset kredensial lokal</button>
          {err && <p className="err">{err}</p>}
          <p className="muted small">
            Bot: @{me?.username || me?.first_name} · topic storage {cfg.topics.storage}.
            Auto-lock 10 menit idle.
          </p>
        </div>
      </div>
    </div>
  );
}

function Drop({ hint }) { return hint ? <div className="drop">Lepaskan file di sini</div> : null; }
