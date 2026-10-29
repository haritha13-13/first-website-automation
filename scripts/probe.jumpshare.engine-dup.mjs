#!/usr/bin/env node
import fs from "node:fs";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity } from "/home/haritha_13/behance-backlink-automator/src/browser/browser.js";
import { runAction } from "/home/haritha_13/behance-backlink-automator/src/actions/actions.js";
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

// raw upload of an existing-name file -> forces the "File already exists" dialog
const file = "/mnt/c/Users/haris/Downloads/ai-automation (1).docx";
await page.locator("#_upload_input").setInputFiles(file);
await page.waitForTimeout(9000);

const popup = await page.evaluate(() => (document.querySelector(".file_replace_popup") ? document.querySelector(".file_replace_popup").textContent.replace(/\s+/g, " ").trim().slice(0, 120) : "NO POPUP"));
console.log("popup visible:", popup);

console.log("engine click( text: Duplicate, optional ) ->");
const out = await runAction(page, { id: "resolve-duplicate", action: "click", text: "Duplicate" }, { input: {} }).then((r) => r).catch((e) => ({ err: e.message }));
console.log("  result:", JSON.stringify(out));
await page.waitForTimeout(10000);

const rows = await page.evaluate(() => [...document.querySelectorAll("a.thumb-title")].slice(0, 4).map((a) => ({ title: a.getAttribute("title"), href: a.getAttribute("href") })));
console.log("rows now:", JSON.stringify(rows, null, 1));
await closeBrowser(browser);
process.exit(0);