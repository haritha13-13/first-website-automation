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
  text: (document.body?.innerText || "").replace(/\n{2,}/g, "\n").slice(-350),
}), label).then((s) => { console.log("\n===== " + s.label + " =====\nURL: " + s.url + "\n" + s.text.slice(-220)); });

await page.goto("https://dochub.com/new", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
await page.waitForTimeout(5000);
await page.locator("input[type=file]").first().setInputFiles(DOC).catch(() => {});
await page.waitForTimeout(12000);
await page.evaluate(() => {
  const el = [...document.querySelectorAll("button")].find((b) => /^Create Document$/i.test((b.textContent || "").trim()));
  if (el) el.click();
}).catch(() => {});
await page.waitForTimeout(15000);

// Now in the editor — scan top toolbar for Share / Done / back controls
const scan = await page.evaluate(() => {
  const btns = [...document.querySelectorAll("button, [role='button'], a")].map((b) => ({
    t: (b.textContent || "").trim().replace(/\s+/g, " ").slice(0, 22),
    title: (b.title || "").slice(0, 22),
    id: b.id,
    href: (b.href || "").slice(0, 40),
    aria: b.getAttribute("aria-label") || "",
  })).filter((b) => b.t || b.title || b.aria || b.id || b.href);
  return btns.slice(0, 60);
});
console.log("EDITOR CONTROLS:");
for (const b of scan) console.log("  ", JSON.stringify(b));

// Any dialog/iframe?
const frames = page.frames().map((f) => f.url());
console.log("\nFRAMES:", JSON.stringify(frames, null, 1));
await closeBrowser(browser);
process.exit(0);