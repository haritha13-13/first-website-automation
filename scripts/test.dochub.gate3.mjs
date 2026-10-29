#!/usr/bin/env node
/**
 * DocHub gate attempt #3 (existing doc, full handoff to the user).
 * Opens an existing document's editor, surfaces the Share dialog,
 * then lets the USER perform: Get Shareable Link -> Continue with reCAPTCHA
 * -> solve. Polls up to 4 min for the resulting link. All progress is
 * written to scripts/.gate3.log AND stdout.
 */
import fs from "node:fs";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity, persistSession } from "/home/haritha_13/behance-backlink-automator/src/browser/browser.js";
import { loadEnv } from "/home/haritha_13/behance-backlink-automator/src/common/env.js";
loadEnv();
const ROOT = "/home/haritha_13/behance-backlink-automator";
const LOG = new fs.createWriteStream(ROOT + "/scripts/.gate3.log", { flags: "w" });
const log = (s) => { LOG.write(s + "\n"); process.stdout.write(s + "\n"); };

const browser = await launchBrowser();
const { page, context } = await newPage(browser, {
  storageState: fs.existsSync(ROOT + "/data/session.json") ? ROOT + "/data/session.json" : undefined,
});
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});
const popups = [];
context.on("page", async (p) => { popups.push(p); try { log("   [popup opened] " + p.url()); } catch {} });

setTimeout(() => { log("WATCHDOG: forcing exit"); process.exit(2); }, 260000).unref();

log("step1: open dashboard");
await page.goto("https://dochub.com/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => log("goto err " + e.message.split("\n")[0]));
await page.waitForTimeout(6000);
const docUrl = await page.evaluate(() => {
  const a = [...document.querySelectorAll("a")].find((x) => /dochub\.com\/speedbotsdm\//.test(x.href || "") && !/\/new$/.test(x.href));
  return a ? a.href : "";
}).catch(() => "");
if (!docUrl) { log("NO DOCS FOUND"); await closeBrowser(browser); process.exit(1); }
log("step2: open existing doc " + docUrl);
await page.goto(docUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => log("goto2 err " + e.message.split("\n")[0]));
await page.waitForTimeout(10000);
await page.evaluate(() => {
  const skip = [...document.querySelectorAll("button, [role='button']")].find((e) => /^Skip$/i.test((e.textContent || "").trim()) && e.getBoundingClientRect().width > 0);
  if (skip) skip.click();
}).catch(() => {});
await page.waitForTimeout(2500);

log("step3: open Share dialog (#share-send-btn)");
const shareClicked = await page.evaluate(() => { const b = document.querySelector("#share-send-btn"); if (b) { b.click(); return true; } return false; }).catch(() => false);
log("share clicked: " + shareClicked);
await page.waitForTimeout(5000);

log("\n>>> NOW IN THE BROWSER WINDOW, DO THIS:\n");
log(">>> 1. Click \"Get Shareable Link\" in the Share dialog.");
log(">>> 2. If a \"Verification Required\" box appears, click \"Continue with reCAPTCHA\" and solve it.");
log(">>> 3. When you see a link / \"Copy Link\" in the browser, leave it on screen.\n>>> I am polling for it (up to ~4 min).\n");

let found = "";
let initialHint = "";
const deadline = Date.now() + 230000;
let backPress = false;
while (Date.now() < deadline && !found) {
  const s = await page.evaluate(() => {
    const t = document.body?.innerText || "";
    const cand = [...document.querySelectorAll("input")].map((i) => (i.value || "")).filter((u) => u.includes("http"));
    const anchors = [...document.querySelectorAll("a")].map((a) => a.href || "").filter((u) => /dochub\.com\/(d|s|share|view)\//i.test(u));
    return { url: location.href, t, cand: [...cand, ...anchors] };
  }).catch(() => ({ url: "", t: "", cand: [] }));
  if (/help\.dochub\.com|faq|knowledge-base/i.test(s.url) && !backPress) {
    log("   [we drifted to help page; navigating back to doc editor] " + s.url);
    await page.goto(docUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(8000);
    backPress = true;
  }
  for (const u of s.cand) { if (u.includes("dochub.com/")) { found = u; break; } }
  const linkish = /Anyone with the link can|Copy Link|Shareable link|Set link/i.test(s.t.slice(-2500));
  const gate = /Verification Required|reCAPTCHA|verify your account/i.test(s.t.slice(-2500));
  if (!initialHint) initialHint = /Verification Required/i.test(s.t.slice(-2500)) ? "verification-gate" : "unknown";
  if (linkish && !found) { found = "LINKHINT:" + (/Copy Link/i.test(s.t.slice(-2500)) ? "copy-link-shown" : "anyone" ); }
  const n = Math.round((Date.now() - (deadline - 230000)) / 1000);
  log(`  t+${n}s gate=${gate} linkish=${linkish} cand=${s.cand.length} url=${s.url.slice(0, 70)}`);
  await page.waitForTimeout(4000);
}
for (const p of popups) {
  try { const u = p.url(); if (!found && /dochub\.com\/(d|s|share|view)\//.test(u)) found = u; log("   [popup] " + u); } catch {}
}
log("\n--- final visible text (tail) ---");
log((await page.evaluate(() => (document.body?.innerText || "").slice(-700)).catch(() => "")));
log("\nSHAREABLE_LINK=" + (found || "NONE") + "   initialHint=" + initialHint);
if (found && !found.startsWith("LINKHINT")) await persistSession(context, { email: "speedbotsdm@gmail.com", siteName: "dochub" }).catch(() => {});
await closeBrowser(browser);
LOG.end();
process.exit(found ? 0 : 1);