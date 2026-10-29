#!/usr/bin/env node
/**
 * Live JumpShare run (current account: speedbotsdm@gmail.com).
 *
 *   - Reuses the persistent Chrome profile + data/session.json (JumpShare is
 *     logged in from probe3.jumpshare.login3.mjs).
 *   - Land on https://jumpshare.com/ (redirects to the personal library),
 *     upload the body document via #_upload_input.
 *   - Resolves the public share URL from the row anchor a.thumb-title
 *     (href=/share/<token>, title=<filename>) and confirms it over HTTP.
 *
 * Usage: node scripts/run.live.jumpshare.mjs ["title"] ["/path/to/document"]
 *        ["keyword"] ["backlink URL"]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity } from "../src/browser/browser.js";
import { executeWorkflow } from "../src/workflow/engine.js";
import { resolveJumpshareShareUrl } from "../src/orchestrator.js";
import { loadEnv } from "../src/common/env.js";
import { ok, warn } from "../src/common/util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
loadEnv();

const [titleArg, docArg, keywordArg, backlinkArg] = process.argv.slice(2);
const doc = docArg || "/home/haritha_13/content_agent/output/blogs/ai-automation-for-coimbatore.txt";
if (!fs.existsSync(doc)) { console.error("missing document:", doc); process.exit(1); }

const input = {
  title: titleArg || "AI Automation",
  description: (fs.readFileSync(doc, "utf8") || "").trim(),
  bodyDocumentPath: doc,
  bodyDocumentTxtPath: doc,
  keyword: keywordArg || "",
  backlinkUrl: backlinkArg || "",
  reviewPublish: false,
};

const browser = await launchBrowser();
const { page, context } = await newPage(browser, { storageState: path.join(ROOT, "data/session.json") });
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});

const wf = JSON.parse(fs.readFileSync(path.join(ROOT, "workflows/jumpshare-com.workflow.json"), "utf8"));

console.log("\n=== Running live upload on jumpshare.com ===");
const result = await executeWorkflow({ workflow: wf, input, page, context });

console.log("\n--- results ---");
for (const r of result.results) {
  const state = r.skipped ? "skip" : r.failed ? "FAIL" : "ok";
  console.log(` [${state}] ${r.stepId} ${r.action}${r.error ? " -> " + r.error : ""}${r.skipped && r.reason ? "  reason: " + r.reason : ""}`);
}

const fileName = input.bodyDocumentPath ? path.basename(input.bodyDocumentPath).replace(/\.[^.]+$/, "") : "";
const publishedUrl = await resolveJumpshareShareUrl(page, { fileName, title: input.title });
console.log("\npublishedUrl:", publishedUrl);
console.log("failures:", result.failures.length ? result.failures.join(", ") : "(none)");

if (publishedUrl && /jumpshare\.com\/share\//.test(publishedUrl)) {
  await context.storageState({ path: path.join(ROOT, "data/session.json") }).catch(() => {});
  ok("JumpShare share link captured: " + publishedUrl);
} else {
  warn("No JumpShare share link captured.");
}

await closeBrowser(browser);
process.exit(/jumpshare\.com\/share\//.test(publishedUrl) ? 0 : 1);