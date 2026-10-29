#!/usr/bin/env node
import fs from "node:fs";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity } from "../src/browser/browser.js";
import { loadEnv } from "../src/common/env.js";

loadEnv();
const ROOT = "/home/haritha_13/behance-backlink-automator";

const browser = await launchBrowser();
const { page, context } = await newPage(browser, {
  storageState: fs.existsSync(ROOT + "/data/session.json") ? ROOT + "/data/session.json" : undefined,
});
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});

await page.goto("https://app.mediafire.com/folder/myfiles", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(10000);

const files = await page.evaluate(() => {
  const rows = [...document.querySelectorAll("a,div,li,span")].map((e) => (e.textContent || "").trim());
  const names = [...new Set(rows)].filter((t) => /ai[- ]automation/i.test(t) && t.length < 60).slice(0, 20);
  const allText = (document.body.innerText || "").replace(/\s+/g, " ");
  const count = (allText.match(/ai[- ]automation/gi) || []).length;
  return { names, count };
});
console.log("ai-automation mentions in DOM:", files.count);
console.log("distinct name strings:", JSON.stringify(files.names, null, 1));

await closeBrowser(browser);
process.exit(0);