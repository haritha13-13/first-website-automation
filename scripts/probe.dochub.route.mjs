#!/usr/bin/env node
import fs from "node:fs";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity } from "/home/haritha_13/behance-backlink-automator/src/browser/browser.js";
import { loadEnv } from "/home/haritha_13/behance-backlink-automator/src/common/env.js";
loadEnv();
const ROOT = "/home/haritha_13/behance-backlink-automator";
const browser = await launchBrowser();
const { page, context } = await newPage(browser, {
  storageState: fs.existsSync(ROOT + "/data/session.json") ? ROOT + "/data/session.json" : undefined,
});
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});
page.on("framenavigated", (f) => { if (f === page.mainFrame()) console.log("  navigated ->", f.url()); });

const snap = (label) => page.evaluate((label) => ({
  label, url: location.href,
  text: (document.body?.innerText || "").replace(/\n{2,}/g, "\n").slice(0, 300),
}), label).then((s) => console.log("\n===== " + s.label + " =====\nURL: " + s.url + "\n" + s.text.slice(0, 200)));

// Reach the logged-in app via a fresh navigation + JS redirect capture
await page.goto("https://www.dochub.com/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
await page.waitForTimeout(6000);
await snap("www root after 6s");

// Try the "/app" style SPA entry: look for a route that renders dashboard
const routes = ["https://www.dochub.com/account", "https://www.dochub.com/my", "https://www.dochub.com/files", "https://www.dochub.com/main", "https://www.dochub.com/editor"];
for (const u of routes) {
  await page.goto(u, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const t = await page.evaluate(() => (document.body?.innerText || "").slice(0, 80).replace(/\n+/g, " "));
  console.log(`\nroute ${u}\n   -> ${JSON.stringify(t)}` + (page.url() !== u ? "  (final:" + page.url() + ")" : ""));
  if (/Dashboard|Personal|Import a Document/.test(t)) { console.log("   ^^^ DASHBOARD FOUND"); break; }
}
await closeBrowser(browser);
process.exit(0);