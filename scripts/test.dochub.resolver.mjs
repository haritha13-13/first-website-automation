#!/usr/bin/env node
import fs from "node:fs";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity } from "/home/haritha_13/behance-backlink-automator/src/browser/browser.js";
import { loadEnv } from "/home/haritha_13/behance-backlink-automator/src/common/env.js";
loadEnv();
const ROOT = "/home/haritha_13/behance-backlink-automator";
const { resolveDochubShareUrl } = await import(ROOT + "/src/orchestrator.js");

const browser = await launchBrowser();
const { page, context } = await newPage(browser, {
  storageState: fs.existsSync(ROOT + "/data/session.json") ? ROOT + "/data/session.json" : undefined,
});
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});
setTimeout(() => process.exit(2), 90000).unref();

await page.goto("https://dochub.com/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
await page.waitForTimeout(5000);
const docUrl = await page.evaluate(() => {
  const a = [...document.querySelectorAll("a")].find((x) => /dochub\.com\/speedbotsdm\//.test(x.href || "") && !/\/new$/.test(x.href));
  return a ? a.href : "";
});
console.log("opening existing doc:", docUrl);
await page.goto(docUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
await page.waitForTimeout(12000);

const link = await resolveDochubShareUrl(page);
console.log("\nRESOLVER RESULT:", JSON.stringify(link));
if (link) {
  const res = await fetch(link, { signal: AbortSignal.timeout(20000) });
  console.log("HTTP status:", res.status, "(expect 200)");
}
await closeBrowser(browser);
process.exit(link ? 0 : 1);