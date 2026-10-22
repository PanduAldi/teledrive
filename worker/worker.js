// Cloudflare Worker (opsional): proxy Bot API + /file/ dengan CORS, token tidak
// pernah menyentuh browser. Membuka batas 20 MB Bot API (chunk ≥20 MB di-stitch
// server-side) + progress download nyata via fetch().
//
// Deploy:
//   1. dashboard.cloudflare.com → Workers → Create Worker → paste file ini
//   2. Settings → Variables → secret BOT_TOKEN = token dari @BotFather
//   3. Salin URL *.workers.dev ke Settings di aplikasi
//
// Endpoint: semua method Bot API lewat POST /<method>, file via GET /file/<path>.

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = {
      "Access-Control-Allow-Origin": req.headers.get("Origin") || "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const upstream = url.pathname.startsWith("/file/")
      ? `https://api.telegram.org/file/bot${env.BOT_TOKEN}${url.pathname.slice(5)}`
      : `https://api.telegram.org/bot${env.BOT_TOKEN}${url.pathname}`;

    const headers = new Headers(cors);
    const res = await fetch(upstream, {
      method: req.method,
      headers: req.method === "POST" ? req.headers : undefined,
      body: req.method === "POST" ? req.body : undefined,
      // @cf/cloudflare streams by default; pass ~through~ range headers untouched
    });
    for (const h of ["Content-Range", "Accept-Ranges", "Content-Length", "Content-Type", "Content-Disposition"]) {
      if (res.headers.has(h)) headers.set(h, res.headers.get(h));
    }
    return new Response(res.body, { status: res.status, headers });
  },
};
