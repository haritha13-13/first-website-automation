#!/usr/bin/env node
import fs from "node:fs";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity } from "../src/browser/browser.js";
import { resolveDochubShareUrl } from "../src/orchestrator.js";
import { loadEnv } from "../src/common/env.js";
loadEnv();
const ROOT = "/home/haritha_13/behance-backlink-automator";
const DOC_URL = process.argv[2] || "https://dochub.com/speedbotsdm/Noek8bMwx7NB2XdVl7d2qm/accounting-automation-1-docx";

const browser = await launchBrowser();
const { page, context } = await newPage(browser, {
  storageState: fs.existsSync(ROOT + "/data/session.json") ? ROOT + "/data/session.json" : undefined,
});
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});

await page.goto(DOC_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(10000);
console.log("url:", page.url());

const url = await resolveDochubShareUrl(page).catch((e) => { console.log("err:", e.message); return ""; });
console.log("resolved:", url || "(none)");

let ok = false;
if (url) {
  try { const vp = await context.newPage(); const r = await vp.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 }); ok = !!r && r.ok(); console.log("browser tab HTTP:", r ? r.status() : "?"); await vp.close(); } catch (e) { console.log("confirm err:", e.message); }
}
await context.storageState({ path: ROOT + "/data/session.json" }).catch(() => {});
await closeBrowser(browser);
console.log("RESULT:", ok ? "PUBLISHED" : "pending");
process.exit(ok ? 0 : 1);