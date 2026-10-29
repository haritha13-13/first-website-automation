#!/usr/bin/env node
/**
 * Probe: log in to MediaFire fresh (credentials from .env) and report whether
 * the My Files app becomes usable (Upload button present). Uses the launch-time
 * DNS override, so run with:
 *   AUTOMATOR_HOST_RESOLVER_RULES="MAP www.mediafire.com 104.18.213.225" AUTOMATOR_HEADLESS=0 node scripts/_probe.mf.login.mjs
 */
import path from "node:path";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity } from "../src/browser/browser.js";
import { loadEnv } from "../src/common/env.js";

const ROOT = "/home/haritha_13/behance-backlink-automator";
loadEnv();
const email = process.env.MEDIAFIRE_EMAIL || process.env.BEHANCE_EMAIL;
const password = process.env.MEDIAFIRE_PASSWORD || process.env.BEHANCE_PASSWORD;

const browser = await launchBrowser();
const { page, context } = await newPage(browser, { storageState: path.join(ROOT, "data/session.json") });
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});

const vis = "e => e.offsetWidth||e.offsetHeight";

console.log("goto login...");
await page.goto("https://www.mediafire.com/login/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => console.log("goto err", e.message));
await page.waitForTimeout(5000);
console.log("after goto url:", page.url());

// If already logged in it may redirect to the app.
if (!/login/i.test(page.url())) {
  console.log("no login form (already authenticated or redirected).");
} else {
  const e1 = await page.$('input[name="login_email"]');
  const e2 = await page.$('input[name="login_pass"], input[type="password"]');
  console.log("email field:", !!e1, "pass field:", !!e2);
  if (e1 && e2 && email && password) {
    await e1.fill(email);
    await e2.fill(password);
    const candidates = await page.$$('button[type=submit], input[type=submit], #loginStep0 button, button:has-text("LOG IN"), button:has-text("Log in")');
    let clicked = false;
    for (const c of candidates) {
      if (await c.isVisible().catch(() => false)) {
        await c.click().catch(() => {});
        clicked = true;
        break;
      }
    }
    if (!clicked) await e2.press("Enter").catch(() => {});
    await page.waitForTimeout(14000);
  }
}
console.log("after login url:", page.url());

console.log("goto myfiles...");
await page.goto("https://app.mediafire.com/folder/myfiles", { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => console.log("goto err", e.message));
await page.waitForTimeout(12000);

const dump = await page.evaluate(() => {
  const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(e).display !== "none"; };
  const btns = [...document.querySelectorAll("button, [role='button'], a")].filter(visible).map((b) => b.getAttribute("aria-label") || (b.textContent || "").trim().slice(0, 30)).filter(Boolean);
  const files = [...document.querySelectorAll("input[type=file]")].map((i) => ({ accept: i.accept || "", cls: (i.className + "").slice(0, 30) }));
  return { url: location.href, title: document.title, buttons: [...new Set(btns)].slice(0, 30), fileInputs: files, text: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 200) };
});
console.log(JSON.stringify(dump, null, 1));

await context.storageState({ path: path.join(ROOT, "data/session.json") }).catch(() => {});
await closeBrowser(browser);
process.exit(0);