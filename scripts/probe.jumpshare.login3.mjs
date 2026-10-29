#!/usr/bin/env node
/**
 * JumpShare login — clean handoff. Pre-fills the form, then the USER ticks the
 * Cloudflare Turnstile checkbox and clicks Log In themselves. This script only
 * watches for the post-login redirect and then maps the app.
 */
import fs from "node:fs";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity, persistSession } from "/home/haritha_13/behance-backlink-automator/src/browser/browser.js";
import { loadEnv } from "/home/haritha_13/behance-backlink-automator/src/common/env.js";
loadEnv();
const ROOT = "/home/haritha_13/behance-backlink-automator";
const EMAIL = "speedbotsdm@gmail.com";
const PASSWORD = "speedbotsdm@2025";
const browser = await launchBrowser();
const { page, context } = await newPage(browser, {
  storageState: fs.existsSync(ROOT + "/data/session.json") ? ROOT + "/data/session.json" : undefined,
});
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});
page.on("framenavigated", (f) => { if (f === page.mainFrame()) console.log("   NAV ->", f.url()); });
setTimeout(() => process.exit(2), 150000).unref();

const isLogin = (u) => /jumpshare\.com\/login/.test(u);

await page.goto("https://jumpshare.com/login", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(5000);

// If the previous "require you to login again" banner is on a query URL, reload clean.
if (/\?ctnk=/.test(page.url())) {
  await page.goto("https://jumpshare.com/login", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(4000);
}

await page.evaluate(({ EMAIL, PASSWORD }) => {
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  };
  set("user_email", EMAIL);
  set("password", PASSWORD);
}, { EMAIL, PASSWORD }).catch(() => {});
console.log("form pre-filled: " + EMAIL);

console.log("\n>>> DO THIS IN THE BROWSER WINDOW:");
console.log(">>> 1. Tick the Cloudflare 'Verify you are human' checkbox (solve any puzzle).");
console.log(">>> 2. Click the 'Log In' button.");
console.log(">>> 3. If a confirmation code is emailed, enter it.");
console.log(">>> I'm watching — after you're logged in I'll explore the app automatically.\n");

let loggedIn = false;
const dead = Date.now() + 140000;
let lastUrl = page.url();
while (Date.now() < dead && !loggedIn) {
  const u = await page.evaluate(() => location.href).catch(() => "");
  if (u !== lastUrl) { console.log("   [url changed]", u); lastUrl = u; }
  if (!isLogin(u) && u && /jumpshare/.test(u)) loggedIn = true;
  await page.waitForTimeout(1500);
}

console.log("\nlogged-in URL:", lastUrl);
const text = await page.evaluate(() => (document.body?.innerText || "")).catch(() => "");
console.log("--- body head ---\n" + text.slice(0, 700));

const links = await page.evaluate(() => {
  const out = new Set();
  for (const a of document.querySelectorAll("a")) {
    const h = a.href || "";
    if (/jumpshare\.com/.test(h) && !/login|signup|forgot|features|pricing|about|blog|help|status|legal|terms|privacy|careers|contact|download|press|trust|security/i.test(h)) out.add(h);
  }
  return [...out].slice(0, 30);
}).catch(() => []);
console.log("\n--- app links ---\n" + links.join("\n"));

const loggedInFlag = /log ?out|logout|upload|library|dashboard/i.test(text) && !/sign in to jumpshare/i.test(text);
console.log("\nlogged in?:", loggedInFlag, "| url:", lastUrl);
if (loggedInFlag || !isLogin(lastUrl)) {
  await persistSession(context, { email: EMAIL, siteName: "jumpshare" }).catch((e) => console.log("persist err:", e.message.split("\n")[0]));
  console.log("session persisted");
}
await closeBrowser(browser);
process.exit(0);