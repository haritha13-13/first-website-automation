#!/usr/bin/env node
/**
 * Test: does the Chrome window survive navigating + clicking "Sign In"
 * (the exact point where the user reported the window closing)?
 * Watches for renderer crashes and browser disconnects for 75s.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, getOzonePlatform } from "../src/browser/browser.js";
import { loadEnv } from "../src/common/env.js";
import { ok, warn } from "../src/common/util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
loadEnv();
process.env.AUTOMATOR_HEADLESS = "0";
const outDir = path.join(ROOT, "artifacts");
fs.mkdirSync(outDir, { recursive: true });

let crashed = false;
let disconnected = false;
const events = [];

const browser = await launchBrowser();
browser.on("disconnected", () => { disconnected = true; events.push("browser DISCONNECTED"); });
console.log("ozone platform:", getOzonePlatform());
const { page, context } = await newPage(browser);
page.on("crash", () => { crashed = true; events.push("page CRASHED"); });
await maximizeBrowserWindow(context).catch(() => warn("maximize failed"));

await page.goto("https://www.behance.net/", { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(3000);
events.push(`after goto behance: connected=${browser.isConnected()} url=${page.url()}`);

// Click the visible Sign In entry (the reported failure point).
const clicked = await page.evaluate(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const c = getComputedStyle(e); return r.width > 0 && r.height > 0 && c.display !== "none" && c.visibility !== "hidden"; };
  const byText = [...document.querySelectorAll("a, button")].filter(vis).find((e) => {
    const t = (e.textContent || "").replace(/\s+/g, " ").trim();
    const href = e.getAttribute("href") || "";
    return /^\s*(sign ?in|log ?in)\s*$/i.test(t) || /sign ?in|log ?in/i.test(e.getAttribute("aria-label") || "") || /auth\.services\.adobe|adobelogin/i.test(href);
  });
  if (byText) { byText.click(); return true; }
  return false;
}).catch(() => false);
events.push(`clicked Sign In: ${clicked}`);
await page.waitForTimeout(5000);

// Watch for 70s — survive the Adobe/Google OAuth transition (the reported crash point).
for (let i = 0; i < 14; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  if (!browser.isConnected()) { events.push(`t=${(i + 1) * 5}s browser gone`); break; }
  const url = page.isClosed() ? "(page closed)" : page.url();
  events.push(`t=${(i + 1) * 5}s alive url=${url.slice(0, 70)}`);
}

const shot = path.join(outDir, "signin-probe.png");
if (browser.isConnected() && !page.isClosed()) {
  await page.screenshot({ path: shot, fullPage: false }).catch(() => warn("screenshot failed"));
}
console.log("--- events ---");
for (const e of events) console.log(" ", e);
console.log("crashed:", crashed, " disconnected:", disconnected);
console.log("still connected:", browser.isConnected(), " screenshot:", fs.existsSync(shot) ? shot : "NONE");
if (browser.isConnected()) { ok("RESULT: window survived Sign In click — no premature close."); await closeBrowser(browser); process.exit(0); }
console.log("RESULT: browser closed/crashed before sign-in completed.");
process.exit(1);