#!/usr/bin/env node
/**
 * JumpShare login (Turnstile-assisted): fills the form, then waits for you to
 * tick the Cloudflare "I'm not a robot" checkbox in the visible window, then
 * submits and maps the post-login app.
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
setTimeout(() => process.exit(2), 200000).unref();

await page.goto("https://jumpshare.com/login", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(6000);

const fill = await page.evaluate(({ EMAIL, PASSWORD }) => {
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  };
  return { email: set("user_email", EMAIL), pass: set("password", PASSWORD) };
}, { EMAIL, PASSWORD }).catch((e) => ({ err: e.message }));
console.log("filled:", JSON.stringify(fill));

// Wait for the user to tick Turnstile, then detect token presence.
console.log("\n>>> If a Cloudflare 'Verify you are human' checkbox appears in the browser, tick it now.");
console.log(">>> Once the box is ticked (gets a checkmark), I'll submit the form automatically.\n");
let dead = Date.now() + 150000;
let tokenReady = false;
while (Date.now() < dead && !tokenReady) {
  const state = await page.evaluate(() => {
    const hidden = [...document.querySelectorAll("input[name*='turnstile'], input[name='cf-turnstile-response']")];
    const hasToken = hidden.some((i) => (i.value || "").length > 20);
    const nav = location.href;
    return { hasToken, nav };
  }).catch(() => ({ hasToken: false, nav: "" }));
  if (state.nav !== "https://jumpshare.com/login" && !/\/login$/.test(state.nav)) { tokenReady = true; break; }
  if (state.hasToken) tokenReady = true;
  await page.waitForTimeout(1500);
}
console.log("turnstile token ready:", tokenReady, "url:", await page.evaluate(() => location.href));

if (tokenReady && /\/login$/.test(await page.evaluate(() => location.href))) {
  await page.evaluate(() => { const b = document.getElementById("submitaction"); if (b) b.click(); });
  console.log("submitted");
}
await page.waitForTimeout(14000);
console.log("final url:", await page.evaluate(() => location.href));

const appText = await page.evaluate(() => (document.body?.innerText || "").slice(0, 900));
console.log("\n--- post-login text (head) ---\n" + appText);

const links = await page.evaluate(() => {
  const anchors = [...document.querySelectorAll("a")].map((a) => ({ t: (a.textContent || "").trim().slice(0, 24), href: a.href || "" }))
    .filter((a) => /jumpshare/i.test(a.href) && !/login|signup|forgot|features|pricing|about|blog/i.test(a.href));
  return [...new Set(anchors.map((a) => a.href))].slice(0, 25);
});
console.log("\n--- app links ---\n" + links.join("\n"));

const logSession = /log ?out|logout|upload|dashboard|library/i.test(appText) && !/sign in to jumpshare/i.test(appText);
console.log("\nlogged in?:", logSession);
if (logSession) {
  await persistSession(context, { email: EMAIL, siteName: "jumpshare" }).catch((e) => console.log("persist err:", e.message.split("\n")[0]));
  console.log("session persisted");
}
await closeBrowser(browser);
process.exit(0);