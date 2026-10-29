import http from "node:http";
import { execFile } from "node:child_process";
import { config } from "../config.js";
import { subscribeOutput } from "../common/util.js";

// Crisp live mirror of the automation, served to the USER'S OWN Windows
// browser at http://localhost:PORT. This is a 1:1, full-resolution stream of
// what the agent sees (unlike the WSLg window, which can stay soft), plus a
// scrolling feed of every action the agent performs (clicks, fills, navs).

const PORT = Number(process.env.AUTOMATOR_WATCH_PORT || 8600);
const state = {
  png: null,
  url: "",
  title: "",
  ts: 0,
  actions: [],
};

async function captureFrame(page) {
  let buf = null;
  try {
    buf = await page.screenshot({ type: "png", scale: "css" });
  } catch {
    buf = null;
  }
  state.png = buf;
  try {
    state.url = page.url();
    state.title = (await page.title().catch(() => "")) || "";
  } catch {
    /* page closing */
  }
  state.ts = Date.now();
}

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Automation Watch</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Segoe UI, Arial, sans-serif; background: #111; color: #e6e6e6; }
  header { position: sticky; top: 0; z-index: 2; background: #1c1c1e; padding: 10px 16px; border-bottom: 1px solid #333; }
  #title { font-size: 16px; font-weight: 600; color: #fff; }
  #url   { font-size: 13px; color: #7ad; word-break: break-all; margin-top: 2px; }
  #status { font-size: 12px; color: #9a9; margin-top: 2px; }
  main { display: flex; gap: 14px; padding: 14px 16px; align-items: flex-start; }
  #left { flex: 1 1 70%; min-width: 0; }
  #right { flex: 1 1 30%; min-width: 260px; }
  img#shot { width: 100%; border: 1px solid #333; border-radius: 6px; background:#fff; }
  h2 { font-size: 13px; color: #bbb; margin: 0 0 8px; text-transform: uppercase; letter-spacing: .05em; }
  #actions { list-style: none; margin: 0; padding: 0; max-height: 78vh; overflow-y: auto; font-family: Consolas, monospace; font-size: 12px; line-height: 1.55; }
  #actions li { white-space: pre-wrap; word-break: break-word; padding: 3px 6px; border-left: 3px solid transparent; }
  #actions li.ok { border-left-color: #2c6; color: #cfe9cf; }
  #actions li.warn { border-left-color: #c93; color: #f5e0c2; }
  #actions li.err { border-left-color: #c33; color: #f6c9c9; }
  #actions li.meta { border-left-color: #555; color: #9ea; }
</style>
</head>
<body>
<header>
  <div id="title">Automation Watch</div>
  <div id="url">connecting…</div>
  <div id="status"></div>
</header>
<main>
  <div id="left"><img id="shot" alt="live automation page"/></div>
  <div id="right">
    <h2>Live actions — what the agent is clicking / typing / navigating</h2>
    <ul id="actions"></ul>
  </div>
</main>
<script>
const shot = document.getElementById('shot');
const urlEl = document.getElementById('url');
const titleEl = document.getElementById('title');
const statusEl = document.getElementById('status');
const actionsEl = document.getElementById('actions');
let lastCount = 0;
async function tick() {
  try {
    const r = await fetch('/frame?t=' + Date.now());
    const j = await r.json();
    if (j.png) shot.src = 'data:image/png;base64,' + j.png;
    if (j.title) titleEl.textContent = j.title;
    if (j.url) urlEl.textContent = j.url;
    statusEl.textContent = 'updated ' + new Date(j.ts).toLocaleTimeString() + ' · ' + Math.round((navigator.deviceMemory||0)*8000) + 'MB · pixel ratio ' + window.devicePixelRatio;
    if (j.actions && j.actions.length !== lastCount) {
      lastCount = j.actions.length;
      actionsEl.innerHTML = j.actions.map(a =>
        '<li class="' + (a[0] === 'warn' ? 'warn' : a[0] === 'err' ? 'err' : a[0] === 'ok' ? 'ok' : 'meta') + '">' + a[1].replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</li>'
      ).join('');
      actionsEl.scrollTop = actionsEl.scrollHeight;
    }
  } catch (e) { statusEl.textContent = 'offline: ' + e.message; }
  setTimeout(tick, 1800);
}
tick();
</script>
</body>
</html>`;

function openInWindowsBrowser() {
  try {
    execFile("explorer.exe", ["http://localhost:" + PORT], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* windows interop unavailable — user opens the URL manually */
  }
}

export function startWatch(page, { intervalMs = 1800 } = {}) {
  // Opt-in only (AUTOMATOR_WATCH=1). Default is off: the user watches the
  // real Chrome-for-testing window, not a localhost mirror.
  if (process.env.AUTOMATOR_WATCH !== "1") return { stop() {} };

  // Action feed: capture every ok/warn/info/error the agent prints.
  const off = subscribeOutput((entry) => {
    state.actions.push(entry);
    if (state.actions.length > 300) state.actions.splice(0, state.actions.length - 300);
  });

  const server = http.createServer((req, res) => {
    try {
      if (req.url.startsWith("/frame")) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          png: state.png ? state.png.toString("base64") : null,
          url: state.url,
          title: state.title,
          ts: state.ts,
          actions: state.actions,
        }));
        return;
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(PAGE_HTML);
    } catch {
      res.statusCode = 500;
      res.end("{}");
    }
  });

  server.on("error", (err) => {
    console.warn(`[watch] server failed on :${PORT} — ${err.message}`);
  });
  server.listen(PORT, "0.0.0.0");

  const timer = setInterval(() => {
    if (page.isClosed()) return stop();
    captureFrame(page).catch(() => {});
  }, intervalMs);
  captureFrame(page).catch(() => {});

  console.log(`[watch] LIVE mirror ready — open  http://localhost:${PORT}  (crisp, full resolution, your own browser)`);
  openInWindowsBrowser();

  function stop() {
    clearInterval(timer);
    off();
    try { server.close(); } catch { /* already closed */ }
  }
  return { stop };
}