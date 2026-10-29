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
  text: (document.body?.innerText || "").replace(/\n{2,}/g, "\n").slice(-500),
}), label).then((s) => { console.log("\n===== " + s.label + " =====\nURL: " + s.url + "\n" + s.text.slice(-280)); });

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

// Click "Get Shareable Link"
const clk = await page.evaluate(() => {
  const el = [...document.querySelectorAll("button, [role='button'], a, div, span, li")].find((e) => {
    const t = (e.textContent || "").trim();
    return /^Get Shareable Link$/.test(t) && e.getBoundingClientRect().width > 0 && e.children.length <= 2;
  });
  if (el) { el.click(); return { hit: true, tag: el.tagName }; }
  return { hit: false };
});
console.log("click Get Shareable Link:", JSON.stringify(clk));
await page.waitForTimeout(6000);
await snap("after shareable link");

const ui = await page.evaluate(() => ({
  text: (document.body?.innerText || "").slice(-600),
  inputs: [...document.querySelectorAll("input")].filter((i) => (i.value || "").includes("dochub.com") || /url|link|share/i.test(i.id + i.className)).map((i) => ({ id: i.id, val: (i.value || "").slice(0, 90), readonly: i.readOnly })),
  links: [...document.querySelectorAll("a")].filter((a) => /dochub\.com\/[a-z]/i.test(a.href || "")).map((a) => (a.href || "").slice(0, 80)),
  copyBtns: [...document.querySelectorAll("button")].filter((b) => /copy|link/i.test((b.textContent || "").trim())).map((b) => ({ t: (b.textContent || "").trim().slice(0, 20), id: b.id })),
  previews: [...document.querySelectorAll("[data-testid*='link' i], [class*='link' i]")].map((e) => ({ t: (e.textContent || "").trim().slice(0, 60), cls: (e.className + "").slice(0, 30) })).slice(0, 8),
}));
console.log("\nSHARABLE UI:", JSON.stringify(ui, null, 1));
await closeBrowser(browser);
process.exit(0);