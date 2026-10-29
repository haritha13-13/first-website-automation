#!/usr/bin/env node
/**
 * Live regression test for the reported bug: blogfreely site is down (Cloudflare
 * 522), every workflow step fails, yet the run was recorded "published".
 * This runs the REAL workflow + REAL verifier against the live (down) site and
 * applies the orchestrator's exact status logic.
 */
import fs from "node:fs";
import path from "node:path";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity } from "/home/haritha_13/behance-backlink-automator/src/browser/browser.js";
import { executeWorkflow } from "/home/haritha_13/behance-backlink-automator/src/workflow/engine.js";
import { verifySubmission } from "/home/haritha_13/behance-backlink-automator/src/verify/verifier.js";
import { loadEnv } from "/home/haritha_13/behance-backlink-automator/src/common/env.js";
loadEnv();
const ROOT = "/home/haritha_13/behance-backlink-automator";

const wf = JSON.parse(fs.readFileSync(path.join(ROOT, "workflows/blogfreely-net.workflow.json"), "utf8"));
const input = {
  siteName: "blogfreely",
  siteUrl: "https://blogfreely.net/",
  username: "speedbots",
  title: "information",
  description: "information about accounting automation for Coimbatore businesses.",
  keyword: "automation",
  backlinkUrl: "https://speedbots.io/AI-Invoicing-Automation",
  reviewPublish: false,
};

const browser = await launchBrowser();
const { page, context } = await newPage(browser, { storageState: ROOT + "/data/session.json" });
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});

const execution = await executeWorkflow({ workflow: wf, input, page });
const hasHardFail = execution.failures.length > 0;
let publishedUrl = execution.publishedUrl;
let status = "pending";

console.log("\n=== Execution ===");
for (const r of execution.results) {
  console.log(` [${r.failed ? "FAIL" : r.skipped ? "skip" : "ok"}] ${r.stepId}${r.error ? " -> " + r.error : ""}`);
}
console.log(`failures=${execution.failures.length} publishedUrl=${JSON.stringify(publishedUrl)}`);
if (hasHardFail) {
  status = "failed";
  console.log(`[warn] Workflow finished with ${execution.failures.length} failed step(s). Running verification anyway.`);
}

console.log("\n=== Verification (real verifier, live site) ===");
const verification = await verifySubmission({ page, workflow: wf, expectedUrl: publishedUrl, input });
if (verification.verified) {
  status = "published";
  publishedUrl = verification.url || publishedUrl;
} else if (!hasHardFail) {
  status = "pending";
}
console.log(`attempts=${JSON.stringify(verification.attempts)}`);
console.log("\n=== RESULT ===");
console.log(`status=${status}`);
console.log(`publishedUrl=${JSON.stringify(publishedUrl)}`);

await closeBrowser(browser);
const pass = status === "failed";
console.log(pass ? "\nPASS: downgraded site-down run recorded as failed (not published)." : "\nFAIL: recorded wrong status.");
process.exit(pass ? 0 : 1);