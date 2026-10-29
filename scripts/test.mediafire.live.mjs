#!/usr/bin/env node
/**
 * End-to-end MediaFire test, exactly matching the user's real run:
 *   - input.bodyDocumentUrl = a .docx from Windows Downloads ("ai-automation (1).docx")
 *   - executeWorkflow -> (NO DOM verifier for mediafire) -> resolveMediaFireShareUrl
 * Copy of the current orchestrator MediaFire branch.
 */
import fs from "node:fs";
import path from "node:path";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity } from "/home/haritha_13/behance-backlink-automator/src/browser/browser.js";
import { executeWorkflow } from "/home/haritha_13/behance-backlink-automator/src/workflow/engine.js";
import { resolveMediaFireShareUrl } from "/home/haritha_13/behance-backlink-automator/src/orchestrator.js";
import { loadEnv } from "/home/haritha_13/behance-backlink-automator/src/common/env.js";
loadEnv();
const ROOT = "/home/haritha_13/behance-backlink-automator";

const doc = "/mnt/c/Users/haris/Downloads/ai-automation (1).docx";
if (!fs.existsSync(doc)) { console.error("missing doc:", doc); process.exit(1); }

const input = {
  title: "ai automation",
  description: "AI automation for smart scalable growth.",
  bodyDocumentUrl: doc,
  bodyDocumentPath: doc,
  bodyDocumentTxtPath: doc,
  keyword: "",
  backlinkUrl: "",
  reviewPublish: false,
};

const browser = await launchBrowser();
const { page, context } = await newPage(browser, { storageState: ROOT + "/data/session.json" });
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});

const wf = JSON.parse(fs.readFileSync(path.join(ROOT, "workflows/mediafire-com.workflow.json"), "utf8"));

console.log("=== executeWorkflow ===");
const exec = await executeWorkflow({ workflow: wf, input, page, context });
for (const r of exec.results) console.log(` [${r.failed ? "FAIL" : r.skipped ? "skip" : "ok"}] ${r.stepId}${r.error ? " -> " + r.error : ""}`);

console.log("\n=== MediaFire resolution (current orchestrator order) ===");
const fileName = input.bodyDocumentPath ? path.basename(input.bodyDocumentPath).replace(/\.[^.]+$/, "") : "";
console.log("hints:", JSON.stringify({ fileName, title: input.title }));

const url = await resolveMediaFireShareUrl(page, { fileName, title: input.title });
console.log("resolved url:", url || "(none)");

let confirmed = false;
if (url) {
  try { const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20000) }); confirmed = res.ok; console.log("node HTTP:", res.status); }
  catch (e) { console.log("node confirm err:", e.message); }
  if (!confirmed) {
    console.log("trying via browser tab (honors --host-resolver-rules)...");
    try {
      const vp = await context.newPage();
      try {
        const r2 = await vp.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
        confirmed = !!r2 && r2.ok();
        console.log("browser tab HTTP:", r2 ? r2.status() : "(no response)");
      } finally { await vp.close().catch(() => {}); }
    } catch (e2) { console.log("browser confirm err:", e2.message); }
  }
}

await context.storageState({ path: ROOT + "/data/session.json" }).catch(() => {});
await closeBrowser(browser);
console.log("\nRESULT:", confirmed ? "PUBLISHED -> " + url : "pending (no share link)");
process.exit(confirmed ? 0 : 1);