#!/usr/bin/env node
import fs from "node:fs";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity } from "/home/haritha_13/behance-backlink-automator/src/browser/browser.js";
import { loadEnv } from "/home/haritha_13/behance-backlink-automator/src/common/env.js";
loadEnv();
const ROOT = "/home/haritha_13/behance-backlink-automator";
const { resolveJumpshareShareUrl } = await import(ROOT + "/src/orchestrator.js");

const browser = await launchBrowser();
const { page, context } = await newPage(browser, {
  storageState: fs.existsSync(ROOT + "/data/session.json") ? ROOT + "/data/session.json" : undefined,
});
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});
setTimeout(() => process.exit(2), 90000).unref();

const link = await resolveJumpshareShareUrl(page, { fileName: "ai-automation (1).docx", title: "" });
console.log("\nRESOLVER RESULT:", JSON.stringify(link));
if (link) {
  const res = await fetch(link, { redirect: "follow", signal: AbortSignal.timeout(20000) });
  console.log("HTTP status:", res.status, "(expect 200)");
}
await closeBrowser(browser);
process.exit(link ? 0 : 1);