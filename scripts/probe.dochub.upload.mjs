#!/usr/bin/env node
import fs from "node:fs";
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
  text: (document.body?.innerText || "").replace(/\n{2,}/g, "\n").slice(0, 300),
}), label).then((s) => { console.log("\n===== " + s.label + " =====\nURL: " + s.url + "\n" + s.text.slice(0, 160)); });

await page.goto("https://dochub.com/new", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
await page.waitForTimeout(6000);
await snap("/new upload page");

const fi = page.locator("input[type=file]").first();
console.log("file input:", await fi.getAttribute("id"));
await fi.setInputFiles(DOC).catch((e) => console.log("setInputFiles err:", e.message.split("\n")[0]));
console.log("uploaded:", DOC);
await page.waitForTimeout(15000);
await snap("after upload");

// dump share/link and doc-list UI
const ui = await page.evaluate(() => ({
  links: [...document.querySelectorAll("a")].map((a) => ({ t: (a.textContent || "").trim().slice(0, 26), href: (a.href || "").slice(0, 60) })).filter((a) => a.t || a.href).slice(0, 20),
  btns: [...document.querySelectorAll("button")].map((b) => ({ t: (b.textContent || "").trim().slice(0, 24), id: b.id, cls: (b.className + "").split(" ").slice(0, 2).join(" ") })).filter((b) => b.t).slice(0, 20),
  previews: [...document.querySelectorAll("[class*='preview'], [class*='thumbnail'], canvas")].length,
}));
console.log("\nUI:", JSON.stringify(ui, null, 1));
await closeBrowser(browser);
process.exit(0);