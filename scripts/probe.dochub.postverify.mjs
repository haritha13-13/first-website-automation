#!/usr/bin/env node
/**
 * Check post-verification state: does Get Shareable Link still ask for
 * verification? Print full dialog, popup URLs, clipboard candidates.
 */
import fs from "node:fs";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity, persistSession } from "/home/haritha_13/behance-backlink-automator/src/browser/browser.js";
import { loadEnv } from "/home/haritha_13/behance-backlink-automator/src/common/env.js";
loadEnv();
const ROOT = "/home/haritha_13/behance-backlink-automator";
const DOC = process.env.DOCHUB_DOC || "/mnt/c/Users/haris/Downloads/ai-automation (1).docx";

const browser = await launchBrowser();
const { page, context } = await newPage(browser, {
  storageState: fs.existsSync(ROOT + "/data/session.json") ? ROOT + "/data/session.json" : undefined,
});
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});
const popups = [];
context.on("page", async (p) => {
  popups.push(p);
  console.log("   [popup open]", p.url());
});

await page.goto("https://dochub.com/new", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(5000);
await page.locator("input[type=file]").first().setInputFiles(DOC).catch(() => {});
await page.waitForTimeout(12000);
await page.evaluate(() => {
  const el = [...document.querySelectorAll("button")].find((b) => /^Create Document$/i.test((b.textContent || "").trim()));
  if (el) el.click();
}).catch(() => {});
await page.waitForTimeout(15000);
await page.evaluate(() => {
  const skip = [...document.querySelectorAll("button, [role='button']")].find((e) => /^Skip$/i.test((e.textContent || "").trim()) && e.getBoundingClientRect().width > 0);
  if (skip) skip.click();
}).catch(() => {});
await page.waitForTimeout(2500);
await page.evaluate(() => { const b = document.querySelector("#share-send-btn"); if (b) b.click(); }).catch(() => {});
await page.waitForTimeout(5000);
await page.evaluate(() => {
  const el = [...document.querySelectorAll("button, [role='button'], a, div, span")].find((e) => {
    const t = (e.textContent || "").replace(/\s+/g, " ").trim();
    return /^Get Shareable Link/i.test(t) && e.getBoundingClientRect().width > 0 && e.children.length <= 3;
  });
  if (el) el.click();
}).catch(() => {});
await page.waitForTimeout(6000);

const full = await page.evaluate(() => ({
  bodyText: document.body?.innerText || "",
  inputs: [...document.querySelectorAll("input")].map((i) => ({ id: i.id, val: (i.value || "").slice(0, 120) })),
  dialogTexts: [...document.querySelectorAll("[role='dialog'], [class*='modal' i], [class*='dialog' i]")].map((d) => (d.innerText || "").slice(0, 300)).filter((t) => t),
}));
console.log("\nDFULL visible text (tail 1500):\n" + full.bodyText.slice(-1500));
console.log("\nINPUTS:", JSON.stringify(full.inputs));
console.log("\nDIALOG TEXTS:", JSON.stringify(full.dialogTexts, null, 1));

await page.waitForTimeout(8000);
for (const p of popups) {
  try { console.log("\n[popup url]", p.url(), "\n[popup text]", (await p.evaluate(() => (document.body?.innerText || "").slice(0, 300)))); } catch (e) { console.log("[popup err]", e.message.split("\n")[0]); }
}

try {
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
  console.log("\nCLIPBOARD:", JSON.stringify(clip));
} catch (e) { console.log("\nCLIPBOARD err:", e.message.split("\n")[0]); }

await closeBrowser(browser);
process.exit(0);