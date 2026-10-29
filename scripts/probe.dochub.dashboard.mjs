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
  text: (document.body?.innerText || "").replace(/\n{2,}/g, "\n").slice(0, 700),
  inputs: [...document.querySelectorAll("input")].map((i) => ({ id: i.id, type: i.type, cls: (i.className + "").split(" ")[0], accept: i.accept })),
  btns: [...document.querySelectorAll("button, a[role='button'], a.btn, label")].map((e) => ({ t: (e.textContent || "").trim().slice(0, 28), id: e.id, cls: (e.className + "").split(" ")[0], for: e.htmlFor })).filter((b) => b.t).slice(0, 22),
}), label).then((s) => { console.log("\n===== " + s.label + " =====\nURL: " + s.url + "\n" + s.text); console.log("INPUTS:", JSON.stringify(s.inputs)); console.log("BTNS:", JSON.stringify(s.btns, null, 0)); });

await page.goto("https://app.dochub.com/documents", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => page.goto("https://www.dochub.com/dashboard", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {}));
await page.waitForTimeout(4000);
await snap("documents/dashboard");

// persist the working session
await persistSession(context, { email: EMAIL, siteName: "dochub" }).catch((e) => console.log("persist err:", e.message.split("\n")[0]));
console.log("\nsession persisted.");

await closeBrowser(browser);
process.exit(0);