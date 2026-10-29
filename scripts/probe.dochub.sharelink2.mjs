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
  text: (document.body?.innerText || "").replace(/\n{2,}/g, "\n").slice(-600),
}), label).then((s) => { console.log("\n===== " + s.label + " =====\nURL: " + s.url + "\n" + s.text.slice(-400)); });

await page.goto("https://dochub.com/new", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
await page.waitForTimeout(5000);
await page.locator("input[type=file]").first().setInputFiles(DOC).catch(() => {});
await page.waitForTimeout(12000);
await page.evaluate(() => {
  const el = [...document.querySelectorAll("button")].find((b) => /^Create Document$/i.test((b.textContent || "").trim()));
  if (el) el.click();
}).catch(() => {});
await page.waitForTimeout(15000);

// dismiss onboarding then open share
await page.evaluate(() => {
  const skip = [...document.querySelectorAll("button, [role='button']")].find((e) => /^Skip$/i.test((e.textContent || "").trim()) && e.getBoundingClientRect().width > 0);
  if (skip) skip.click();
}).catch(() => {});
await page.waitForTimeout(2500);
await page.evaluate(() => { const b = document.querySelector("#share-send-btn"); if (b) b.click(); }).catch(() => {});
await page.waitForTimeout(5000);

// Click "Get Shareable Link" with loose whitespace handling
const clk = await page.evaluate(() => {
  const el = [...document.querySelectorAll("button, [role='button'], a, div, span")].find((e) => {
    const t = (e.textContent || "").replace(/\s+/g, " ").trim();
    return /^Get Shareable Link/i.test(t) && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0 && e.children.length <= 3;
  });
  if (el) { el.click(); return { hit: true, tag: el.tagName, cls: (el.className + "").slice(0, 40) }; }
  return { hit: false };
});
console.log("click:", JSON.stringify(clk));
await page.waitForTimeout(7000);
await snap("after Get Shareable Link");

const ui = await page.evaluate(() => ({
  text: (document.body?.innerText || "").slice(-800),
  inputs: [...document.querySelectorAll("input")].filter((i) => (i.value || "").includes("dochub.com") || /link|url/i.test(i.id + i.className)).map((i) => ({ id: i.id, val: (i.value || "").slice(0, 100) })),
  links: [...document.querySelectorAll("a")].filter((a) => /dochub\.com\/[a-z]/i.test(a.href || "") && (a.href || "").length < 90).map((a) => (a.href || "").slice(0, 90)),
  copyBtns: [...document.querySelectorAll("button, [role='button']")].filter((b) => /copy|clipboard/i.test((b.textContent || "").trim() + b.id)).map((b) => ({ t: (b.textContent || "").trim().slice(0, 20), id: b.id })),
}));
console.log("\nSHARABLE UI:", JSON.stringify(ui, null, 1));
await closeBrowser(browser);
process.exit(0);