#!/usr/bin/env node
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
const snap = (label) => page.evaluate((label) => ({
  label, url: location.href,
  text: (document.body?.innerText || "").replace(/\n{2,}/g, "\n").slice(0, 400),
  btns: [...document.querySelectorAll("button, a[role='button'], a.btn, [role='menuitem']")].map((e) => ({ t: (e.textContent || "").trim().slice(0, 26), id: e.id, href: (e.href || "").slice(0, 50) })).filter((b) => b.t).slice(0, 24),
}), label).then((s) => { console.log("\n===== " + s.label + " =====\nURL: " + s.url + "\n" + s.text.slice(0, 250)); console.log("CTRLS:", JSON.stringify(s.btns, null, 0)); });

await page.goto("https://dochub.com/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
await page.waitForTimeout(6000);
await snap("dashboard");

// Click "New Document"
const clicked = await page.evaluate(() => {
  const el = [...document.querySelectorAll("a, button, [role='menuitem'], [role='button'], span, div")].find((e) => {
    const t = (e.textContent || "").trim();
    return /^New Document$/i.test(t) && e.getBoundingClientRect().width > 0;
  });
  if (el) { el.click(); return { ok: true, text: el.textContent.trim() }; }
  return { ok: false };
});
console.log("\nclick New Document:", JSON.stringify(clicked));
await page.waitForTimeout(6000);
await snap("after New Document");

// find file input / upload prompts
const up = await page.evaluate(() => ({
  inputs: [...document.querySelectorAll("input[type=file]")].map((i) => ({ id: i.id, accept: (i.accept || "").slice(0, 40) })),
  dropzones: [...document.querySelectorAll("[class*='drop'], [class*='upload'], [class*='import']")].map((e) => ({ t: (e.textContent || "").trim().slice(0, 30), cls: (e.className + "").split(" ").slice(0,2).join(" ") })).slice(0, 8),
}));
console.log("\nUPLOAD:", JSON.stringify(up, null, 1));
await closeBrowser(browser);
process.exit(0);