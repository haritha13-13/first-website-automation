#!/usr/bin/env node
import fs from "node:fs";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity } from "/home/haritha_13/behance-backlink-automator/src/browser/browser.js";
import { loadEnv } from "/home/haritha_13/behance-backlink-automator/src/common/env.js";
loadEnv();
const ROOT = "/home/haritha_13/behance-backlink-automator";
const DOC = process.env.DOCHUB_DOC || "/mnt/c/Users/haris/Downloads/accounting-automation.docx";
const browser = await launchBrowser();
const { page, context } = await newPage(browser, {
  storageState: fs.existsSync(ROOT + "/data/session.json") ? ROOT + "/data/session.json" : undefined,
});
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});
setTimeout(() => process.exit(2), 90000).unref();

await page.goto("https://dochub.com/new", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
await page.waitForTimeout(5000);
await page.locator("input[type=file]").first().setInputFiles(DOC).catch(() => {});
await page.waitForTimeout(12000);
await page.evaluate(() => {
  const el = [...document.querySelectorAll("button")].find((b) => /^Create Document$/i.test((b.textContent || "").trim()));
  if (el) el.click();
}).catch(() => {});
await page.waitForTimeout(8000);
const s = await page.evaluate(() => {
  const t = document.body?.innerText || "";
  return {
    capHit: /Creation Cap Hit/i.test(t),
    inEditor: !!document.querySelector("#share-send-btn"),
    tail: t.slice(-600),
  };
});
console.log("capHit:", s.capHit, "inEditor:", s.inEditor);
console.log("tail:", s.tail);
await closeBrowser(browser);
process.exit(s.inEditor ? 0 : 1);