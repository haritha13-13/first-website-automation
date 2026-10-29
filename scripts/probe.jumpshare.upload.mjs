#!/usr/bin/env node
/**
 * JumpShare full upload -> share-link probe:
 * library -> upload via #_upload_input -> wait -> click Copy Link -> clipboard -> HTTP check.
 */
import fs from "node:fs";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity } from "/home/haritha_13/behance-backlink-automator/src/browser/browser.js";
import { loadEnv } from "/home/haritha_13/behance-backlink-automator/src/common/env.js";
loadEnv();
const ROOT = "/home/haritha_13/behance-backlink-automator";
const DOC = process.env.DOCHUB_DOC || "/mnt/c/Users/haris/Downloads/ai-automation (1).docx";
const browser = await launchBrowser();
const { page, context } = await newPage(browser, {
  storageState: fs.existsSync(ROOT + "/data/session.json") ? ROOT + "/data/session.json" : undefined,
});
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});
page.on("framenavigated", (f) => { if (f === page.mainFrame()) console.log("   NAV ->", f.url()); });
setTimeout(() => process.exit(2), 150000).unref();

console.log("goto library...");
await page.goto("https://jumpshare.com/w/aa7ffd3/personal", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(8000);

console.log("upload via #_upload_input:", DOC);
await page.locator("#_upload_input").first().setInputFiles(DOC).catch((e) => console.log("upload err:", e.message.split("\n")[0]));
await page.waitForTimeout(16000);
console.log("url now:", await page.evaluate(() => location.href));

const text = await page.evaluate(() => (document.body?.innerText || "").replace(/\n{2,}/g, "\n"));
console.log("\n--- body text (tail 600) ---\n" + text.slice(-600));

const shareLinks = await page.evaluate(() => {
  const out = new Set();
  for (const a of document.querySelectorAll("a")) {
    const m = (a.href || "").match(/https:\/\/jumpshare\.com\/(share|v)\/([A-Za-z0-9]+)/);
    if (m) out.add(m[0]);
  }
  for (const i of document.querySelectorAll("input")) {
    const m = (i.value || "").match(/https:\/\/jumpshare\.com\/(share|v)\/([A-Za-z0-9]+)/);
    if (m) out.add(m[0]);
  }
  return [...out];
});
console.log("\nshare links in DOM:", JSON.stringify(shareLinks));

// Try the Copy Link button (viewer_copy_link), fallback to any copy-link control
let clip = "";
const copyBtns = ["#viewer_copy_link", "button:has-text('Copy Link')"];
for (const sel of copyBtns) {
  const h = page.locator(sel).first();
  if (await h.count().catch(() => 0)) {
    await h.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(2000);
    try {
      await page.context().grantPermissions(["clipboard-read"], { origin: "https://jumpshare.com" });
      const c = (await page.evaluate(() => navigator.clipboard.readText().catch(() => "")) || "").trim();
      if (c) { clip = c; break; }
    } catch {}
  }
}
console.log("\nclipboard:", JSON.stringify(clip));

let resolved = clip || shareLinks[0] || "";
if (resolved) {
  const res = await fetch(resolved, { redirect: "follow", signal: AbortSignal.timeout(20000) }).catch((e) => ({ status: "ERR " + e.message.split("\n")[0] }));
  console.log("HTTP status for", resolved, "->", res.status);
}
await closeBrowser(browser);
process.exit(resolved ? 0 : 1);