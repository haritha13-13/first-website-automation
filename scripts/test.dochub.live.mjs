#!/usr/bin/env node
/**
 * End-to-end DocHub test, matching the user's real run:
 *   - input.bodyDocumentPath = a .docx from Windows Downloads
 *   - executeWorkflow -> resolveDochubShareUrl -> confirm HTTP
 */
import fs from "node:fs";
import path from "node:path";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity } from "../src/browser/browser.js";
import { executeWorkflow } from "../src/workflow/engine.js";
import { resolveDochubShareUrl } from "../src/orchestrator.js";
import { loadEnv } from "../src/common/env.js";
loadEnv();
const ROOT = "/home/haritha_13/behance-backlink-automator";

const doc = process.argv[2] || "/mnt/c/Users/haris/Downloads/accounting-automation (1).docx";
if (!fs.existsSync(doc)) { console.error("missing doc:", doc); process.exit(1); }

const input = { bodyDocumentPath: doc, bodyDocumentUrl: doc, bodyDocumentTxtPath: doc, keyword: "", backlinkUrl: "", reviewPublish: false };

const browser = await launchBrowser();
const { page, context } = await newPage(browser, { storageState: ROOT + "/data/session.json" });
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});

const wf = JSON.parse(fs.readFileSync(path.join(ROOT, "workflows/dochub-com.workflow.json"), "utf8"));

console.log("=== executeWorkflow ===");
const exec = await executeWorkflow({ workflow: wf, input, page, context });
for (const r of exec.results) console.log(` [${r.failed ? "FAIL" : r.skipped ? "skip" : "ok"}] ${r.stepId}${r.error ? " -> " + r.error : ""}`);

console.log("\n=== DocHub resolution ===");
console.log("url now:", page.url());
const url = await resolveDochubShareUrl(page).catch((e) => { console.log("resolve err:", e.message); return ""; });
console.log("resolved url:", url || "(none)");

let confirmed = false;
if (url) {
  try {
    const vp = await context.newPage();
    const r2 = await vp.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    confirmed = !!r2 && r2.ok();
    console.log("browser tab HTTP:", r2 ? r2.status() : "?");
    await vp.close().catch(() => {});
  } catch (e) { console.log("browser confirm err:", e.message); }
}

await context.storageState({ path: ROOT + "/data/session.json" }).catch(() => {});
await closeBrowser(browser);
console.log("\nRESULT:", confirmed ? "PUBLISHED -> " + url : "pending (no share link)");
process.exit(confirmed ? 0 : 1);