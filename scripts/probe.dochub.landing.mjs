#!/usr/bin/env node
import fs from "node:fs";
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
page.on("framenavigated", (f) => { if (f === page.mainFrame()) console.log("   NAV ->", f.url()); });

await page.goto("https://dochub.com/sign-in", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
await page.waitForTimeout(2500);
const pwSel = await page.evaluate(() => { const i = document.querySelectorAll("input[type='password']"); return i.length ? i[i.length - 1].id : ""; });
await page.fill("#email", EMAIL).catch(() => {});
await page.fill("#" + pwSel, PASSWORD).catch(() => {});
await page.click("#dh-email-login-btn").catch(() => {});
await page.waitForTimeout(10000);
console.log("\nFINAL URL:", page.url());
const t = await page.evaluate(() => (document.body?.innerText || "").slice(0, 150).replace(/\n+/g, " "));
console.log("BODY:", JSON.stringify(t));
await persistSession(context, { email: EMAIL, siteName: "dochub" }).catch((e) => console.log("persist:", e.message.split("\n")[0]));
await closeBrowser(browser);
process.exit(0);