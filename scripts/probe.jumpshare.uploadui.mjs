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
page.on("framenavigated", (f) => { if (f === page.mainFrame()) console.log("NAV", f.url()); });
setTimeout(() => process.exit(2), 90000).unref();

await page.goto("https://jumpshare.com/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(7000);

const file = "/mnt/c/Users/haris/Downloads/accounting-automation.docx";
const input = page.locator("#_upload_input");
await input.setInputFiles(file);
console.log("uploaded:", file);
await page.waitForTimeout(12000);

const d = await page.evaluate(() => {
  const visible = [...document.querySelectorAll("body *")]
    .filter((e) => e.children.length === 0)
    .map((e) => (e.textContent || "").trim())
    .filter((t) => t.length > 0 && t.length < 120);
  const look = [...document.querySelectorAll("a,button,[class*='dropdown'],[class*='select'],select,[role='listbox'],[role='option']")]
    .filter((e) => e.offsetWidth > 0)
    .map((e) => ({ tag: e.tagName, cls: (e.className + "").slice(0, 40), txt: (e.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60) }));
  const modals = [...document.querySelectorAll("[role='dialog'],[class*='modal'],[class*='toast'],[class*='notif']")].filter((e) => e.offsetWidth > 0).map((e) => (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300));
  const ctgy = [...document.querySelectorAll("*")].filter((e) => /categor|type of|file type/i.test((e.textContent || "").slice(0, 200)) && e.children.length <= 2).slice(0, 10).map((e) => (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120));
  return { featured: [...new Set(visible)].slice(0, 60), controls: [...new Set(look.map((x) => x.cls + " | " + x.txt))].filter((x) => /drop|share|categor|upload|link|copy|toast|notif/i.test(x)).slice(0, 25), modals: modals.filter((m) => m).slice(0, 6), ctgy };
});
console.log(JSON.stringify(d, null, 1));
await closeBrowser(browser);
process.exit(0);