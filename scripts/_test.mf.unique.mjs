#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity } from "../src/browser/browser.js";
import { executeWorkflow } from "../src/workflow/engine.js";
import { resolveMediaFireShareUrl } from "../src/orchestrator.js";
import { loadEnv } from "../src/common/env.js";
loadEnv();
const ROOT = "/home/haritha_13/behance-backlink-automator";

const doc = process.argv[2];
if (!doc || !fs.existsSync(doc)) { console.error("usage: node _test.mf.unique.mjs <docx>"); process.exit(2); }
const base = path.basename(doc).replace(/\.[^.]+$/, "");

const input = { title: base, description: "test", bodyDocumentUrl: doc, bodyDocumentPath: doc, keyword: "", backlinkUrl: "", reviewPublish: false };

const browser = await launchBrowser();
const { page, context } = await newPage(browser, { storageState: ROOT + "/data/session.json" });
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});

const wf = JSON.parse(fs.readFileSync(path.join(ROOT, "workflows/mediafire-com.workflow.json"), "utf8"));
const exec = await executeWorkflow({ workflow: wf, input, page, context });
for (const r of exec.results) console.log(` [${r.failed ? "FAIL" : r.skipped ? "skip" : "ok"}] ${r.stepId}${r.error ? " -> " + r.error : ""}`);

const url = await resolveMediaFireShareUrl(page, { fileName: base, title: base });
console.log("uploaded filename:", path.basename(doc));
console.log("resolved url:", url || "(none)");

let ok = false;
if (url) {
  try { const vp = await context.newPage(); const r2 = await vp.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 }); ok = !!r2 && r2.ok(); console.log("browser tab HTTP:", r2 ? r2.status() : "?"); await vp.close(); } catch (e) { console.log("confirm err", e.message); }
}
await context.storageState({ path: ROOT + "/data/session.json" }).catch(() => {});
await closeBrowser(browser);
console.log("\nRESULT:", ok ? "NEW UPLOAD LIVE -> " + url : "FAILED");
process.exit(ok ? 0 : 1);