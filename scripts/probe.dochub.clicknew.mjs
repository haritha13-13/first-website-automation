#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity, persistSession } from "/home/haritha_13/behance-backlink-automator/src/browser/browser.js";
import { loadEnv } from "/home/haritha_13/behance-backlink-automator/src/common/env.js";
loadEnv();
const ROOT = "/home/haritha_13/behance-backlink-automator";
const DOC = "/mnt/c/Users/haris/Downloads/ai-automation (1).docx";
const browser = await launchBrowser();
const { page, context } = await newPage(browser, {
  storageState: fs.existsSync(ROOT + "/data/session.json") ? ROOT + "/data/session.json" : undefined,
});
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});
page.on("framenavigated", (f) => { if (f === page.mainFrame()) console.log("   NAV ->", f.url()); });
const snap = (label) => page.evaluate((label) => ({
  label, url: location.href,
  text: (document.body?.innerText || "").replace(/\n{2,}/g, "\n").slice(0, 380),
}), label).then((s) => { console.log("\n===== " + s.label + " =====\nURL: " + s.url + "\n" + s.text.slice(0, 220)); });

await page.goto("https://dochub.com/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
await page.waitForTimeout(6000);
await snap("dashboard");

// Click the "New Document" block (div.w-full.px-3.mb-2)
await page.evaluate(() => {
  const div = [...document.querySelectorAll("div")].find((e) => (e.className + "").includes("px-3 mb-2") && /new\s*document/i.test(e.textContent));
  if (div) div.click();
});
await page.waitForTimeout(6000);
await snap("after New Document click");

// Look for file input / import modal
const ui = await page.evaluate(() => ({
  fileInputs: [...document.querySelectorAll("input[type=file]")].map((i) => ({ id: i.id, accept: (i.accept || "").slice(0, 50) })),
  dialogs: [...document.querySelectorAll("[role='dialog'], [class*='modal'], [class*='dialog']")].map((e) => ({ t: (e.textContent || "").trim().slice(0, 60), cls: (e.className + "").split(" ").slice(0, 2).join(" ") })).slice(0, 6),
  text: (document.body?.innerText || "").slice(-600),
}));
console.log("\nUI after click:", JSON.stringify(ui, null, 1));
await closeBrowser(browser);
process.exit(0);