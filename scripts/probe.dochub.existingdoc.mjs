#!/usr/bin/env node
/**
 * Test the share-link gate on an EXISTING doc (no new doc created, so no
 * creation-cap impact). Opens first document, opens Share, clicks Get
 * Shareable Link; prints whether the Verification dialog or the link appears.
 */
import fs from "node:fs";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity, persistSession } from "/home/haritha_13/behance-backlink-automator/src/browser/browser.js";
import { loadEnv } from "/home/haritha_13/behance-backlink-automator/src/common/env.js";
loadEnv();
const ROOT = "/home/haritha_13/behance-backlink-automator";
const browser = await launchBrowser();
const { page, context } = await newPage(browser, {
  storageState: fs.existsSync(ROOT + "/data/session.json") ? ROOT + "/data/session.json" : undefined,
});
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});

setTimeout(() => { console.error("WATCHDOG: forcing exit"); process.exit(2); }, 140000).unref();

console.log("nav dashboard...");
await page.goto("https://dochub.com/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
await page.waitForTimeout(6000);
const docs = await page.evaluate(() => {
  const anchors = [...document.querySelectorAll("a")].map((a) => ({ t: (a.textContent || "").trim().slice(0, 40), href: a.href || "" }))
    .filter((a) => /dochub\.com\/speedbotsdm\//.test(a.href) && !/\/new$/.test(a.href));
  return anchors.slice(0, 8);
});
console.log("doc anchors:", JSON.stringify(docs, null, 1));
const docUrl = docs[0]?.href;
if (!docUrl) { console.log("NO DOCS FOUND"); await closeBrowser(browser); process.exit(1); }
console.log("opening:", docUrl);
await page.goto(docUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
await page.waitForTimeout(10000);

// dismiss onboarding if any
await page.evaluate(() => {
  const skip = [...document.querySelectorAll("button, [role='button']")].find((e) => /^Skip$/i.test((e.textContent || "").trim()) && e.getBoundingClientRect().width > 0);
  if (skip) skip.click();
}).catch(() => {});
await page.waitForTimeout(2500);
const hasShare = await page.evaluate(() => !!document.querySelector("#share-send-btn"));
console.log("share btn present:", hasShare);
if (!hasShare) { console.log("NOT IN EDITOR; body tail:\n" + (await page.evaluate(() => (document.body?.innerText || "").slice(-300)))); await closeBrowser(browser); process.exit(1); }
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

const out = await page.evaluate(() => {
  const t = document.body?.innerText || "";
  const links = [...document.querySelectorAll("a, input")].map((e) => (e.value || e.href || "")).filter((u) => /dochub\.com\/(d|s|share)\//i.test(u));
  return {
    bodyTail: t.slice(-900),
    hasVerification: /Verification Required|reCAPTCHA|verify your account/i.test(t.slice(-2000)),
    hasShareableLink: links.length ? links.slice(0, 3) : (/Anyone with the link|Copy Link/i.test(t.slice(-2000)) ? "hint-found" : ""),
    inputs: [...document.querySelectorAll("input")].filter((i) => (i.value || "").includes("dochub")).map((i) => (i.value || "").slice(0, 90)),
  };
});
console.log("\nRESULT:", JSON.stringify(out, null, 1));
await closeBrowser(browser);
process.exit(0);