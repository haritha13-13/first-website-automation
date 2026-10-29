#!/usr/bin/env node
/**
 * Live MediaFire run (current account: speedbotsdm@gmail.com).
 *
 *   - Reuses the persistent Chrome profile + data/session.json (MediaFire is
 *     logged in from the discovery/manual-login session).
 *   - Uploads the blog body document (the engine renders the description into
 *     a .docx whose anchor KEYWORD links to the backlink URL) to My Files.
 *   - Resolves the public share link via the "Copy share link" clipboard action
 *     (the ONLY way MediaFire exposes the /file/<key>/<name> URL) + confirms it
 *     over HTTP.
 *
 * Usage: node scripts/run.live.mediafire.mjs ["title"] ["/path/to/document"]
 *        ["keyword"] ["backlink URL"]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity } from "../src/browser/browser.js";
import { executeWorkflow } from "../src/workflow/engine.js";
import { resolveMediaFireShareUrl } from "../src/orchestrator.js";
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
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://app.mediafire.com" }).catch(() => {});

const wf = JSON.parse(fs.readFileSync(path.join(ROOT, "workflows/mediafire-com.workflow.json"), "utf8"));

logSectionLocal("Running live upload on mediafire.com");
const result = await executeWorkflow({ workflow: wf, input, page, context });

console.log("\n--- results ---");
for (const r of result.results) {
  const state = r.skipped ? "skip" : r.failed ? "FAIL" : "ok";
  console.log(` [${state}] ${r.stepId} ${r.action}${r.error ? " -> " + r.error : ""}${r.skipped && r.reason ? "  reason: " + r.reason : ""}`);
}

const fileName = input.bodyDocumentPath ? path.basename(input.bodyDocumentPath).replace(/\.[^.]+$/, "") : "";
const publishedUrl = await resolveMediaFireShareUrl(page, { fileName, title: input.title });
console.log("\npublishedUrl:", publishedUrl);
console.log("failures:", result.failures.length ? result.failures.join(", ") : "(none)");

if (publishedUrl && /mediafire\.com\/file\//.test(publishedUrl)) {
  await context.storageState({ path: path.join(ROOT, "data/session.json") }).catch(() => {});
  ok("MediaFire share link captured: " + publishedUrl);
} else {
  warn("No MediaFire share link captured.");
}

await closeBrowser(browser);
process.exit(/mediafire\.com\/file\//.test(publishedUrl) ? 0 : 1);

function logSectionLocal(t) { console.log("\n=== " + t + " ==="); }