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
  text: (document.body?.innerText || "").replace(/\n{2,}/g, "\n").slice(-400),
}), label).then((s) => { console.log("\n===== " + s.label + " =====\nURL: " + s.url + "\n" + s.text.slice(-260)); });

await page.goto("https://dochub.com/new", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
await page.waitForTimeout(5000);
await page.locator("input[type=file]").first().setInputFiles(DOC).catch((e) => console.log("up err:", e.message.split("\n")[0]));
await page.waitForTimeout(12000);

// Click "Create Document"
const c = await page.evaluate(() => {
  const el = [...document.querySelectorAll("button")].find((b) => /^Create Document$/i.test((b.textContent || "").trim()));
  if (!el) return { hit: false };
  el.click();
  return { hit: true, disabled: el.disabled };
});
console.log("\ncreate doc click:", JSON.stringify(c));
await page.waitForTimeout(15000);
await snap("after Create Document");

const ui = await page.evaluate(() => ({
  url: location.href,
  text: (document.body?.innerText || "").replace(/\n{2,}/g, "\n").slice(-500),
  btns: [...document.querySelectorAll("button")].map((b) => ({ t: (b.textContent || "").trim().slice(0, 22), id: b.id, title: b.title })).filter((b) => b.t).slice(0, 26),
  shareHrefs: [...document.querySelectorAll("a")].filter((a) => /share|link/i.test(a.href + a.textContent)).map((a) => ({ t: (a.textContent || "").trim().slice(0, 20), href: (a.href || "").slice(0, 60) })).slice(0, 10),
  fileInputs: [...document.querySelectorAll("input[type=file]")].length,
}));
console.log("\nUI:", JSON.stringify(ui, null, 1));
await closeBrowser(browser);
process.exit(0);