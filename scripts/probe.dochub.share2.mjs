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

// Dismiss any onboarding dialog ("Skip" / "Show Me How" overlay)
const dismissed = await page.evaluate(() => {
  const candidates = [...document.querySelectorAll("button, [role='button'], a, [class*='close' i], [aria-label*='close' i]")];
  const skip = candidates.find((e) => /^Skip$/i.test((e.textContent || "").trim()) && e.getBoundingClientRect().width > 0);
  if (skip) { skip.click(); return "Skip"; }
  const x = candidates.find((e) => /×|✕|close/i.test((e.textContent || "").trim()) && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().width < 60);
  if (x) { x.click(); return "x"; }
  return "none";
});
console.log("dismiss:", dismissed);
await page.waitForTimeout(3000);

// Try clicking Share via JS (bypass overlay actionability)
const share = await page.evaluate(() => {
  const b = document.querySelector("#share-send-btn");
  if (!b) return { hit: false };
  b.click();
  return { hit: true };
});
console.log("share js click:", JSON.stringify(share));
await page.waitForTimeout(6000);
await snap("share dialog");

const ui = await page.evaluate(() => ({
  dialogs: [...document.querySelectorAll("[role='dialog']")].map((d) => ({ t: (d.innerText || "").slice(0, 120), w: Math.round(d.getBoundingClientRect().width) })).filter((d) => d.w > 300),
  inputs: [...document.querySelectorAll("input")].filter((i) => /url|link/i.test(i.id + i.name + i.placeholder) || (i.value || "").includes("dochub.com")).map((i) => ({ id: i.id, val: (i.value || "").slice(0, 90) })),
  links: [...document.querySelectorAll("a")].filter((a) => /dochub\.com\/[a-z]/i.test(a.href || "") && /share|link|public|anyone/i.test(a.href + a.textContent)).map((a) => ({ t: (a.textContent || "").trim().slice(0, 20), href: (a.href || "").slice(0, 70) })).slice(0, 10),
  tabBtns: [...document.querySelectorAll("button, [role='tab']")].map((b) => (b.textContent || "").trim().slice(0, 26)).filter(Boolean).slice(0, 20),
}));
console.log("\nSHARE UI:", JSON.stringify(ui, null, 1));
await closeBrowser(browser);
process.exit(0);