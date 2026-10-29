import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { config } from "../config.js";
import { ok, warn } from "../common/util.js";

// If system libs for Chromium are missing (stripped containers), we vendor
// the required .so files under <root>/vendor; prepend them to LD_LIBRARY_PATH.
function setupVendoredLibs() {
  const candidate = path.join(config.root, "vendor", "usr", "lib", "x86_64-linux-gnu");
  if (!fs.existsSync(candidate)) return;
  const existing = process.env.LD_LIBRARY_PATH ? process.env.LD_LIBRARY_PATH.split(":") : [];
  if (existing.includes(candidate)) return;
  process.env.LD_LIBRARY_PATH = [candidate, ...existing].join(":");
}
setupVendoredLibs();

/**
 * Find chrome/chromium process PIDs whose command line references the given
 * profile directory. Reads /proc directly so we never match our OWN node
 * process (whose argv may contain the path) — only actual chrome binaries.
 */
export function chromeProcessesUsing(profileDir) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return out;
  }
  for (const pid of entries) {
    try {
      const comm = fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim();
      if (!/^(chrome|chromium)$/i.test(comm)) continue;
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
      // Directories can have trailing separators; compare against the resolved base.
      if (!cmdline.includes(path.resolve(profileDir))) continue;
      out.push(Number(pid));
    } catch {}
  }
  return out;
}

/**
 * Chrome shows "Something went wrong when opening your profile. Some features
 * may be unavailable." when a SECOND live Chrome process shares the same user
 * data dir as an already-running one (e.g. a leftover from a previous run that
 * did not fully exit — its lock files are gone but the process is still alive).
 * Destroys the "crash-drop" scenario by closing the previous owner gracefully
 * (then force-kill if it refuses) BEFORE a fresh instance attaches to it.
 */
export async function ensureProfileFree(profileDir, { signal = "SIGTERM", graceMs = 5000 } = {}) {
  const present = chromeProcessesUsing(profileDir);
  if (!present.length) return 0;
  const killed = [];
  for (const pid of present) {
    try {
      process.kill(pid, signal);
      killed.push(pid);
    } catch {}
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    const still = chromeProcessesUsing(profileDir);
    if (!still.length) break;
    for (const pid of still) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (process.env.AUTOMATOR_DEBUG_PROFILE === "1" && killed.length) {
    warn(`Stopped ${killed.join(", ")} holding the reuse profile "${profileDir}".`);
  }
  return killed.length;
}

/**
 * Launch a shared Chromium browser context. Uses a persisted session
 * (storageState) when available so a successful login survives restarts.
 *
 * WSLg focus/raise strategy (root cause of "icon in taskbar but window won't
 * come forward"): XWayland windows are managed by Weston's X11 compatibility
 * layer, where CDP's Browser.setWindowBounds minimize→restore "restack" is a
 * silent NO-OP (verified: Chromium stays "normal" even after a CDP minimize)
 * and taskbar clicks often can't raise the window. Native Wayland clients are
 * real weston/xdg_toplevel windows that DO raise and focus from the taskbar.
 * So in headed mode we prefer --ozone-platform=wayland when a Wayland display
 * exists, falling back to X11 (and finally to bare) if launch fails. Override
 * with AUTOMATOR_OZONE=wayland|x11|auto.
 */
let ozonePlatform = "x11";
export const getOzonePlatform = () => ozonePlatform;

/**
 * Print the remote-debugging URL so the user can see/control the EXACT live
 * browser from their Windows browser — guaranteed visibility even when the
 * WSLg window itself refuses to display.
 */
export function printDevtoolsHelp(port) {
  (async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = (list || []).find((t) => t.type === "page");
      if (page && page.webSocketDebuggerUrl) {
        const ws = page.webSocketDebuggerUrl.replace("ws://", "");
        console.log(`\n=== DevTools view (open this in your WINDOWS browser to see the live Chrome) ===\n  http://localhost:${port}/devtools/inspector.html?ws=${ws}\n====================================================================`);
      } else {
        console.log(`\n=== DevTools view: http://localhost:${port}/json ===\n`);
      }
    } catch {
      console.log(`\n=== DevTools view: http://localhost:${port}/json ===\n`);
    }
  })();
}

function buildBaseArgs() {
  const args = [
    "--disable-blink-features=AutomationControlled",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    // WSLg/VMs: force software rendering so editor-heavy pages paint stably
    // instead of Chromium's GPU/ANGLE init taking the renderer down.
    "--disable-gpu",
    "--use-angle=swiftshader",
    // WSLg scales the window with desktop DPI (~200%): with software rendering
    // the huge scaled surface can come up BLANK/"disabled". Pin scale to 1 so
    // the window always paints and matches the CDP-reported size.
    "--force-device-scale-factor=1",
    // Remote debugging: lets the user open/control this exact browser from their
    // Windows browser via http://localhost:<port>/devtools/inspector.html even
    // when the WSLg window itself is invisible.
    `--remote-debugging-port=${config.browser.debugPort}`,
  ];
  // DNS override escape hatch (needs no root): some environments map a hostname
  // to a private IP that refuses connections (seen here:
  // www.mediafire.com -> 172.16.16.250, while mediafire.com/app resolve to
  // Cloudflare). Chromium can re-map the host per launch via .env:
  //   AUTOMATOR_HOST_RESOLVER_RULES=MAP www.mediafire.com 104.18.213.225
  // Multiple rules are comma-separated, e.g. "MAP a 1.2.3.4, MAP b 5.6.7.8".
  // Read at launch (not import) so values from .env/loadEnv() are applied.
  const rules = process.env.AUTOMATOR_HOST_RESOLVER_RULES;
  if (rules) args.push(`--host-resolver-rules=${rules}`);
  return args;
}

export async function launchBrowser({ headless = config.browser.headless } = {}) {
  const ozone = String(process.env.AUTOMATOR_OZONE || "auto").toLowerCase();

  // PERSISTENT PROFILE path (headed live runs only): Google only trusts a
  // device with a real, re-used profile — a fresh temp profile every run is
  // what re-triggers the "email me a confirmation code" 2FA EACH time. Reuse
  // data/chrome-profile so the first login is the ONLY one that asks.
  if (!headless && config.browser.profileDir) {
    try {
      // A previous run's Chrome that never fully exited would hand the SECOND
      // instance a live-locked profile -> Chrome's "Something went wrong when
      // opening your profile" bubble. Close the previous holder first.
      await ensureProfileFree(config.browser.profileDir);
      fs.mkdirSync(config.browser.profileDir, { recursive: true });
      // Clear stale Chromium lock files (left by a hard-killed instance) so
      // the next launch can reuse the trusted device profile.
      for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
        try {
          fs.rmSync(path.join(config.browser.profileDir, lock), { force: true });
        } catch {}
      }
      const launch = () => chromium.launchPersistentContext(config.browser.profileDir, {
        headless: false,
        slowMo: config.browser.slowMo,
        args: [...buildBaseArgs(), "--start-maximized", "--window-position=0,0"],
        viewport: { width: 1440, height: 900 },
        userAgent: getStealthUserAgent(),
        locale: "en-US",
      });
      let ctx;
      try {
        ctx = await launch();
      } catch (err) {
        // The profile was still contended (another launch won the race, or a
        // process took a moment to die). Force it free and try exactly once more.
        await ensureProfileFree(config.browser.profileDir);
        for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
          try {
            fs.rmSync(path.join(config.browser.profileDir, lock), { force: true });
          } catch {}
        }
        ctx = await launch();
      }
      activeBrowser = ctx.browser();
      persistentCtx = ctx;
      ozonePlatform = "persistent";
      printDevtoolsHelp(config.browser.debugPort);
      ok(`Chrome reuses the persistent profile "${config.browser.profileDir}" — Google treats this device as known, so the one-time email confirmation is expected at most ONCE, never every run.`);
      return {
        _isPersistent: true,
        newContext: async () => persistentCtx,
        close: async () => {
          const c = persistentCtx;
          persistentCtx = null;
          await c.close().catch(() => {});
        },
      };
    } catch (err) {
      warn(`Persistent profile "${config.browser.profileDir}" failed to load (${String(err.message).split("\n")[0]}) — falling back to a fresh temp profile.`);
    }
  }

  const variants = [];
  if (!headless) {
    const show = [...buildBaseArgs(), "--start-maximized", "--window-position=0,0"];
    // WSLg: prefer X11 (XWayland) — Chromium windows there map most reliably
    // to the Windows desktop; Wayland is tried as the fallback and stays the
    // explicit choice via AUTOMATOR_OZONE=wayland.
    if (ozone === "x11" || ozone === "auto" || ozone === "wayland") {
      if (process.env.DISPLAY) variants.push({ args: show, label: "x11" });
    }
    if ((ozone === "auto" || ozone === "wayland") && process.env.WAYLAND_DISPLAY) {
      variants.push({
        args: [...show, "--ozone-platform=wayland", "--ozone-platform-hint=auto"],
        label: "wayland",
      });
    }
  }
  variants.push({ args: buildBaseArgs(), label: "headless" });
  let lastErr = null;
  for (const v of variants) {
    try {
      const browser = await chromium.launch({ headless, slowMo: config.browser.slowMo, args: v.args });
      ozonePlatform = v.label;
      activeBrowser = browser;
      if (!v.label.startsWith("headless")) printDevtoolsHelp(config.browser.debugPort);
      return browser;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export async function newContext(browser, { storageState } = {}) {
  return browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: getStealthUserAgent(),
    locale: "en-US",
    storageState: storageState || undefined,
  });
}

export function getStealthUserAgent() {
  return (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
  );
}

// Chromium is launched by Playwright with device-scale-factor forced to 1, so
// on a DPI-scaled WSLg display its surface is (e.g.) 1440px wide while the
// window is really 1908px — the OS stretches the content 1.325x and it looks
// BLURRY. We compute the true scale as (maximized window width in X pixels) /
// (CSS screen width) and re-create the context with that deviceScaleFactor so
// Chromium renders 1:1 (crisp). Only meaningful in headed mode.
let cachedDisplayScale = null;
async function detectDisplayScale(context, page) {
  const cssW = await page.evaluate(() => window.screen.width).catch(() => 0);
  if (!cssW) return 1;
  try {
    const cdp = await context.newCDPSession(page);
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "maximized" } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const { bounds } = await cdp.send("Browser.getWindowBounds", { windowId });
    if (!bounds.width) return 1;
    return Math.min(2, Math.max(1, Math.round((bounds.width / cssW) * 100) / 100 || 1));
  } catch {
    return 1;
  }
}

export async function newPage(browser, { storageState } = {}) {
  // PERSISTENT profile mode: the context IS the real profile (already holds the
  // trusted-device cookies/state), so no storageState/scale re-creation.
  if (browser && browser._isPersistent) {
    const context = await browser.newContext();
    // The persistent profile still gets the imported/held session cookies so a
    // restored Behance login is honored without a fresh Google login.
    if (storageState && fs.existsSync(storageState)) {
      try {
        const ss = JSON.parse(fs.readFileSync(storageState, "utf8"));
        if (Array.isArray(ss.cookies)) await context.addCookies(ss.cookies);
      } catch {}
    }
    const page = await context.newPage();
    return { page, context };
  }

  const createContext = (deviceScaleFactor) =>
    browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: getStealthUserAgent(),
      locale: "en-US",
      storageState: storageState || undefined,
      ...(deviceScaleFactor ? { deviceScaleFactor } : {}),
    });
  const makePage = async (context) => {
    const page = await context.newPage();
    return { page, context };
  };

  const override = Number(process.env.AUTOMATOR_DEVICE_SCALE_FACTOR || 0);
  if (override >= 1) return makePage(await createContext(override));

  if (config.browser.headless) return makePage(await createContext(undefined));

  // Headed: detect the crisp display scale once, then re-create the context
  // with it so the live window is sharp.
  if (cachedDisplayScale == null) {
    let context = await createContext(undefined);
    let page = await context.newPage();
    cachedDisplayScale = await detectDisplayScale(context, page);
    await context.close();
  }
  return makePage(await createContext(cachedDisplayScale > 1 ? cachedDisplayScale : 1));
}

// Chromium always reports the window as "focused" even when it's stacked
// behind the terminal on WSLg, so document.hasFocus() can't tell us if the
// USER is actually working in the window. Instead we watch REAL input events
// (mouse/touch/keyboard) delivered to a page: if the user just clicked or
// moved the mouse, they're engaged — a re-raise would steal focus and make an
// interactive challenge (reCAPTCHA grid, "Verify" button) blink and drop clicks.
export async function armUserActivity(page) {
  for (const p of [page, ...(page.context()?.pages() || [])]) {
    try {
      await p.evaluate(() => {
        if (window.__auto_activity__) return;
        const s = { last: Date.now() };
        window.__auto_activity__ = s;
        const bump = () => { s.last = Date.now(); };
        for (const e of ["pointerdown", "pointermove", "mousedown", "mouseup", "wheel", "keydown", "touchstart"]) {
          window.addEventListener(e, bump, { capture: true, passive: true });
        }
      });
    } catch {}
  }
}

async function pageUserActive(page, withinMs) {
  const last = await page
    .evaluate(() => (window.__auto_activity__ ? window.__auto_activity__.last : 0))
    .catch(() => 0);
  return Boolean(last) && Date.now() - last < (withinMs || 3000);
}

// While a CAPTCHA is pending the USER is clicking tiles inside the window —
// periodic re-raises must be suspended entirely so the challenge never
// reloads mid-solve.
let raisesSuspended = false;
export const suspendRaise = () => { raisesSuspended = true; };
export const resumeRaise = () => { raisesSuspended = false; };
export const isRaiseSuspended = () => raisesSuspended;

// Clean Ctrl+C handling: the user expects it to STOP, not to leave the
// process spinning into a closed browser. requestStop() sets the flag and
// closes the current browser so any in-flight Playwright call rejects
// immediately; every wait loop checks isStopRequested() and unwinds quietly.
let activeBrowser = null;
let persistentCtx = null;
let stopRequested = false;
export const requestStop = async () => {
  stopRequested = true;
  const b = activeBrowser;
  activeBrowser = null;
  const pc = persistentCtx;
  persistentCtx = null;
  if (pc) await pc.close().catch(() => {});
  if (b) await b.close().catch(() => {});
};
export const isStopRequested = () => stopRequested;

/**
 * Bring the automation's Chromium window(s) onto the screen and to the front.
 * Applies to EVERY page in the context — reCAPTCHA challenges (and other
 * auth popups) open as SEPARATE windows, and those are the ones the user must
 * click. On WSLg a window can sit STACKED BEHIND the terminal: the taskbar
 * icon exists but resizing/maximizing alone never lifts it above the terminal.
 * So by default we force an X11 restack (brief minimize → restore, which
 * re-maps the window above the others) and then apply + CONFIRM the requested
 * state. `gentle: true` skips the restack (for periodic re-assertions that
 * must not minimize the window under the user's cursor).
 * `windowState` can be "normal" (top-left on-screen rect, CLAMPED to the
 * actual screen — a maximized window can exceed the visible screen on WSLg's
 * DPI-scaled virtual desktop and look empty) or "maximized".
 */
export async function raiseBrowserWindow(
  context,
  { left = 8, top = 8, width = 1360, height = 820, windowState = "normal", gentle = false } = {}
) {
  let any = false;
  for (const page of context.pages()) {
    try {
      const cdp = await context.newCDPSession(page);
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      // Gentle re-assertions must NEVER yank focus from a window the user is
      // actively working in — clicking reCAPTCHA tiles / the Verify button is
      // what makes the challenge "blink" and clicks silently drop. Skip when a
      // CAPTCHA pause is in progress, or when the page saw real user input
      // (mouse/touch/keyboard) in the last few seconds. Gentle mode NEVER
      // resizes or repositions the window (that can hide/bury it) — it just
      // keeps it maximized and brings the tab to the front.
      if (gentle) {
        if (raisesSuspended) return any;
        if (await pageUserActive(page, 3000)) continue;
        await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "maximized" } }).catch(() => {});
        await page.bringToFront().catch(() => {});
        any = true;
        continue;
      }
      // Clamp a "normal" window to the real screen size so it can never land
      // (partially) off-screen — WSLg DPI scaling makes the virtual desktop
      // WIDER than the visible monitor, so an unclamped maximize can appear blank.
      const avail = await page
        .evaluate(() => ({ w: window.screen.availWidth || 1920, h: window.screen.availHeight || 1080 }))
        .catch(() => ({ w: 1920, h: 1080 }));
      const bWidth = windowState === "maximized" ? avail.w : Math.min(width, Math.max(avail.w - left, 320));
      const bHeight = windowState === "maximized" ? avail.h : Math.min(height, Math.max(avail.h - top, 240));
      // Maximized: apply restack-with-recovery. On WSLg a maximized window can
      // sit BURIED below the terminal (only a taskbar icon shows) — plain
      // maximize never lifts it. A brief minimize→normal re-maps the X window
      // ABOVE the others. Risk: the toggle can STICK at minimized (known
      // WSLg/Weston quirk) — so after every step we READ the state back, retry,
      // and finally fall back to a guaranteed-visible on-screen NORMAL window
      // (never leaving the user with an invisible one).
      if (windowState === "maximized") {
        const set = (bounds) => cdp.send("Browser.setWindowBounds", { windowId, bounds }).catch(() => {});
        const getState = async () => {
          const { bounds } = await cdp.send("Browser.getWindowBounds", { windowId }).catch(() => ({ bounds: {} }));
          return bounds.windowState;
        };
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const normW = Math.min(width, Math.max(avail.w - left, 320));
        const normH = Math.min(height, Math.max(avail.h - top, 240));
        let state = null;
        for (let attempt = 0; attempt < 4; attempt++) {
          await set({ windowState: "minimized" });
          await sleep(140);
          state = await getState();
          if (state === "minimized") {
            // Re-map back up through a guaranteed-visible on-screen rect.
            await set({ windowState: "normal", left, top, width: normW, height: normH });
            await sleep(180);
          }
          await set({ windowState: "maximized" });
          await sleep(180);
          state = await getState();
          if (state === "maximized") break;
          if (state !== "minimized") break; // visible enough even if not maximized
          // Stuck minimized — retry; on the last pass fall back to a visible
          // normal-size window instead of staying hidden.
          if (attempt === 3) {
            await set({ windowState: "normal", left, top, width: normW, height: normH });
            await sleep(180);
          }
        }
        await page.bringToFront().catch(() => {});
        state = await getState();
        if (state !== "maximized") await set({ windowState: "maximized" }).catch(() => {});
      } else {
        const target = { windowState: "normal", left, top, width: bWidth, height: bHeight };
        for (let attempt = 0; attempt < 3; attempt++) {
          await cdp.send("Browser.setWindowBounds", { windowId, bounds: target });
          await new Promise((resolve) => setTimeout(resolve, 150));
          const { bounds } = await cdp.send("Browser.getWindowBounds", { windowId });
          if (bounds.windowState === "normal") break;
        }
        await page.bringToFront().catch(() => {});
      }
      any = true;
    } catch {
      /* keep going — a closing page must not break the raise for the others */
    }
  }
  return any;
}

/** Maximized + foreground — the most visibly obvious window state. */
export async function maximizeBrowserWindow(context, options = {}) {
  return raiseBrowserWindow(context, { windowState: "maximized", ...options });
}

export async function closeBrowser(browser) {
  if (activeBrowser === browser) activeBrowser = null;
  if (browser) await browser.close().catch(() => {});
}

/**
 * Which account does the persisted session (data/session.json) belong to?
 * Records the email/site used at save time so the run pipeline can detect a
 * caller who supplied a NEW email/password and stop reusing the OLD session
 * (which is what makes posts keep landing on the previous account).
 */
export function readSessionAccount() {
  try {
    return JSON.parse(fs.readFileSync(config.browser.sessionAccount, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Decide whether the stored browser session may be replayed.
 * The reported bug: a NEW email/password was supplied but the automator kept
 * posting to the PREVIOUS account because it blindly replayed the old session.
 * Rules:
 *   - no credentials provided  -> replay whatever session exists
 *   - forceFresh (env)         -> never replay
 *   - recorded account differs -> never replay (fresh login with new creds)
 *   - session exists but no record of its account -> don't replay (safer: the
 *     old session might be some other account entirely)
 *   - recorded account matches -> replay
 */
export function resolveStoredSession({ providedEmail = "", storedAccount = null, forceFresh = false } = {}) {
  const email = String(providedEmail || "").trim();
  const stored = String((storedAccount && storedAccount.email) || "").trim();
  if (!email) return { replay: true, reason: "" };
  if (forceFresh) return { replay: false, reason: "AUTOMATOR_FRESH_LOGIN=1" };
  if (stored && stored !== email) return { replay: false, reason: "email differs from the stored session account" };
  // Reuse any stored browser cookies for the configured account even when the
  // account record is missing — so a completed login is NEVER re-done (no
  // fresh Google login every run). Only when the cookie file is absent do we
  // do a fresh login (the very first time).
  if (!stored && fs.existsSync(config.browser.storageState)) return { replay: true, reason: "stored session cookies reused for the configured account" };
  if (!stored) return { replay: false, reason: "no stored session cookies yet (first login required)" };
  return { replay: true, reason: "" };
}

export async function persistSession(context, { email = "", siteName = "" } = {}) {
  if (context && typeof context.storageState === "function") {
    await context.storageState({ path: config.browser.storageState }).catch(() => {});
  }
  try {
    fs.mkdirSync(path.dirname(config.browser.sessionAccount), { recursive: true });
    fs.writeFileSync(
      config.browser.sessionAccount,
      JSON.stringify({
        email: String(email || "").trim(),
        siteName: String(siteName || "").trim(),
        savedAt: new Date().toISOString(),
      })
    );
  } catch {}
}