#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity, persistSession } from "/home/haritha_13/behance-backlink-automator/src/browser/browser.js";
import { loadEnv } from "/home/haritha_13/behance-backlink-automator/src/common/env.js";
loadEnv();
const ROOT = "/home/haritha_13/behance-backlink-automator";
const EMAIL = "speedbotsdm@gmail.com";
const PASSWORD = "speedbotsdm@2025";

const browser = await launchBrowser();
const { page, context } = await newPage(browser, {
  storageState: fs.existsSync(ROOT + "/data/session.json") ? ROOT + "/data/session.json" : undefined,
});
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});

const snap = (label) => page.evaluate((label) => ({
  label, url: location.href,
  text: (document.body?.innerText || "").replace(/\n{2,}/g, "\n").slice(0, 600),
  btns: [...document.querySelectorAll("button, a[role='button'], a.btn, label")].map((e) => ({ t: (e.textContent || "").trim().slice(0, 26), id: e.id, href: (e.href || "").slice(0, 55) })).filter((b) => b.t).slice(0, 24),
}), label).then((s) => { console.log("\n===== " + s.label + " =====\nURL: " + s.url + "\n" + s.text); console.log("CTRLS:", JSON.stringify(s.btns, null, 0)); });

// Try candidate logged-in URLs
for (const u of ["https://app.dochub.com/", "https://app.dochub.com/dashboard", "https://www.dochub.com/", "https://www.dochub.com/d/dashboard"]) {
  await page.goto(u, { waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(3500);
  const keys = await page.evaluate(() => ({ url: location.href, text: (document.body?.innerText || "").slice(0, 120) }));
  console.log(`\nHIT ${u} -> ${keys.url}`);
  if (/Welcome|Dashboard|Import a Document|Recent|My Documents|GET STARTED/i.test(keys.text)) { console.log("TEXT:", JSON.stringify(keys.text)); }
}
const k = await page.evaluate(() => (document.body?.innerText || "").slice(0, 200));
console.log("\nfinal:", JSON.stringify({ url: page.url(), k }));
await closeBrowser(browser);
process.exit(0);