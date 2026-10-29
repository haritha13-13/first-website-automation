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
setTimeout(() => process.exit(2), 110000).unref();

await page.goto("https://jumpshare.com/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(7000);

const file = "/mnt/c/Users/haris/Downloads/ai-automation (1).docx";
await page.locator("#_upload_input").setInputFiles(file);
console.log("uploaded same-name file");
await page.waitForTimeout(10000);

const rows = () => page.evaluate(() =>
  [...document.querySelectorAll("a.thumb-title")].map((a) => ({ href: a.getAttribute("href"), title: a.getAttribute("title"), text: (a.textContent || "").trim() })));

console.log("\nrows BEFORE:", JSON.stringify(await rows(), null, 1));

const dup = await page.evaluate(() => {
  const popup = document.querySelector(".file_replace_popup");
  if (!popup) return "NO POPUP";
  const byText = [...popup.querySelectorAll("button, a, input[type=button], [role=button]")].find((b) => (b.textContent || "").trim().toLowerCase() === "duplicate"
    || /duplicate/i.test((b.textContent || "").trim()));
  if (byText) { byText.click(); return "clicked:" + (byText.className + "") + ":" + byText.textContent.trim(); }
  return "popup exists but no Duplicate button: " + popup.textContent.replace(/\s+/g, " ").slice(0, 120);
});
console.log("\nDuplicate action:", dup);
await page.waitForTimeout(12000);

console.log("\nrows AFTER:", JSON.stringify(await rows(), null, 1));
console.log("URL:", await page.evaluate(() => location.href));
await closeBrowser(browser);
process.exit(0);