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
const snap = (label) => page.evaluate((label) => ({
  label, url: location.href,
  text: (document.body?.innerText || "").replace(/\n{2,}/g, "\n").slice(0, 500),
  btns: [...document.querySelectorAll("button, a[role='button'], a.btn")].map((e) => ({ t: (e.textContent || "").trim().slice(0, 26), id: e.id, href: (e.href || "").slice(0, 55) })).filter((b) => b.t).slice(0, 20),
}), label).then((s) => { console.log("\n===== " + s.label + " =====\nURL: " + s.url + "\n" + s.text); console.log("CTRLS:", JSON.stringify(s.btns, null, 0)); });

await page.goto("https://dochub.com/sign-in", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
await page.waitForTimeout(2500);
const pwSel = await page.evaluate(() => { const i = document.querySelectorAll("input[type='password']"); return i.length ? i[i.length - 1].id : ""; });
await page.fill("#email", EMAIL).catch(() => {});
await page.fill("#" + pwSel, PASSWORD).catch(() => {});
await page.click("#dh-email-login-btn").catch(() => {});
await page.waitForTimeout(9000);
await snap("landed after login");

// Try common logged-in app paths
for (const u of ["https://www.dochub.com/app", "https://www.dochub.com/documents", "https://www.dochub.com/share", "https://dochub.com/app", "https://app.dochub.com" ]) {
  await page.goto(u, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const t = await page.evaluate(() => (document.body?.innerText || "").slice(0, 90).replace(/\n+/g, " "));
  if (!/nothing here|Back to Homepage/.test(t)) console.log(`\nMAYBE APP URL: ${u} -> ${JSON.stringify(t)} url=${page.url()}`);
}

await snap("final");
await persistSession(context, { email: EMAIL, siteName: "dochub" }).catch((e) => console.log("persist:", e.message.split("\n")[0]));
await closeBrowser(browser);
process.exit(0);