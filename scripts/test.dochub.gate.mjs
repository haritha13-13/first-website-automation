#!/usr/bin/env node
/**
 * FINAL DocHub share-link gate attempt on an EXISTING document.
 * Opens editor -> Share -> Get Shareable Link; a "Verification Required"
 * dialog appears. User clicks "Continue with reCAPTCHA" and solves it.
 * This script polls for the resulting shareable link (input value / anchor /
 * hint text / popup) for up to 3 minutes.
 */
import fs from "node:fs";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity, persistSession } from "/home/haritha_13/behance-backlink-automator/src/browser/browser.js";
import { loadEnv } from "/home/haritha_13/behance-backlink-automator/src/common/env.js";
loadEnv();
const ROOT = "/home/haritha_13/behance-backlink-automator";
const browser = await launchBrowser();
const { page, context } = await newPage(browser, {
  storageState: fs.existsSync(ROOT + "/data/session.json") ? ROOT + "/data/session.json" : undefined,
});
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});
const popups = [];
context.on("page", async (p) => { popups.push(p); console.log("popup:", p.url()); });

setTimeout(() => { console.error("WATCHDOG: forcing exit"); process.exit(2); }, 240000).unref();

await page.goto("https://dochub.com/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
await page.waitForTimeout(6000);
const docUrl = await page.evaluate(() => {
  const a = [...document.querySelectorAll("a")].find((x) => /dochub\.com\/speedbotsdm\//.test(x.href || "") && !/\/new$/.test(x.href));
  return a ? a.href : "";
});
if (!docUrl) { console.log("NO DOCS"); await closeBrowser(browser); process.exit(1); }
console.log("open:", docUrl);
await page.goto(docUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
await page.waitForTimeout(10000);
await page.evaluate(() => {
  const skip = [...document.querySelectorAll("button, [role='button']")].find((e) => /^Skip$/i.test((e.textContent || "").trim()) && e.getBoundingClientRect().width > 0);
  if (skip) skip.click();
}).catch(() => {});
await page.waitForTimeout(2500);
await page.evaluate(() => { const b = document.querySelector("#share-send-btn"); if (b) b.click(); }).catch(() => {});
await page.waitForTimeout(5000);
await page.evaluate(() => {
  const el = [...document.querySelectorAll("button, [role='button'], a, div, span")].find((e) => {
    const t = (e.textContent || "").replace(/\s+/g, " ").trim();
    return /^Get Shareable Link/i.test(t) && e.getBoundingClientRect().width > 0 && e.children.length <= 3;
  });
  if (el) el.click();
}).catch(() => {});
await page.waitForTimeout(6000);

const t0 = await page.evaluate(() => (document.body?.innerText || "").slice(-1200));
console.log("\nGate status: " + (/Verification Required/.test(t0) ? "VERIFICATION REQUIRED — please click \"Continue with reCAPTCHA\" now and solve it." : /shareable|Copy Link|Anyone/.test(t0) ? "LINK READY?" : "unknown") + "\n");
console.log(">>> Holding 3 min. Click Continue with reCAPTCHA in the browser when ready, then solve.\n");

let found = ""; let deadline = Date.now() + 175000;
while (Date.now() < deadline && !found) {
  await page.waitForTimeout(4000);
  const s = await page.evaluate(() => {
    const t = document.body?.innerText || "";
    const cand = [...document.querySelectorAll("input, a")].map((e) => (e.value || e.href || "")).filter((u) => /dochub\.com\/(d|s|share|view)\//i.test(u) || /\?token=/i.test(u));
    return { t: t.slice(-2500), cand };
  });
  for (const u of s.cand) { if (!/docs?\.google/.test(u)) { found = u; break; } }
  const linkish = /Anyone with the link|Copy Link|Shareable link|Set link/i.test(s.t);
  const open = await page.evaluate(() => window.location.href);
  console.log(`  t+${Math.round((Date.now() - (deadline - 175000)) / 1000)}s gate=${/Verification Required/.test(s.t)} linkish=${linkish} popups=${popups.length} url=${open.slice(0, 66)}`);
}
for (const p of popups) {
  try { const u = p.url(); console.log("[popup final]", u); if (/dochub\.com\/(d|s|share|view)\//.test(u) && !found) found = u; } catch {}
}
console.log("\n--- final body tail ---");
console.log((await page.evaluate(() => (document.body?.innerText || "").slice(-700))));
console.log("\nSHAREABLE_LINK=" + (found || "NONE"));
if (found) await persistSession(context, { email: "speedbotsdm@gmail.com", siteName: "dochub" }).catch(() => {});
await closeBrowser(browser);
process.exit(found ? 0 : 1);