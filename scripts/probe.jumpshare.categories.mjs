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
setTimeout(() => process.exit(2), 90000).unref();

await page.goto("https://jumpshare.com/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(7000);

console.log("URL:", await page.evaluate(() => location.href));

// Dump all <select>/<option> lists and any visible "category"-like control.
const d = await page.evaluate(() => {
  const selects = [...document.querySelectorAll("select")].map((s) => ({
    id: s.id, cls: (s.className + "").slice(0, 40), name: s.name,
    options: [...s.options].map((o) => (o.textContent || "").trim()).slice(0, 20),
  }));
  const catEls = [...document.querySelectorAll("*")]
    .filter((e) => /categor|album|group|tag/i.test((e.id || "") + " " + (e.className || "")) && e.querySelectorAll("*").length < 30)
    .slice(0, 15)
    .map((e) => ({ tag: e.tagName, id: e.id, cls: (e.className + "").slice(0, 40), txt: (e.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80) }));
  const visibleDialogs = [...document.querySelectorAll("[role='dialog'],[class*='modal'],[class*='popup'],[class*='toast'],[class*='notification']")]
    .filter((e) => e.offsetWidth > 0 && e.querySelectorAll("*").length < 200)
    .map((e) => ({ tag: e.tagName, id: e.id, cls: (e.className + "").slice(0, 50), txt: (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200) }));
  return { selects, catEls, visibleDialogs };
});
console.log(JSON.stringify(d, null, 1));

await closeBrowser(browser);
process.exit(0);