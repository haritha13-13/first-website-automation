#!/usr/bin/env node
/**
 * Live Behance MULTI-TAG publish test: actually publishes a project with
 * several tags, then fetches the live project page and reads the tags Behance
 * saved — proving every tag (not just the first) is applied.
 *
 * Usage: AUTOMATOR_HEADLESS=0 node scripts/test.behance.publish.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity, readSessionAccount, resolveStoredSession, persistSession } from "../src/browser/browser.js";
import { executeWorkflow } from "../src/workflow/engine.js";
import { isLoggedIn } from "../src/workflow/agent.js";
import { loadEnv } from "../src/common/env.js";
import { config } from "../src/config.js";
import { logSection, ok } from "../src/common/util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WF = path.join(ROOT, "workflows", "behance-net.workflow.json");
loadEnv();

const email = "speedbotsdm@gmail.com";
const password = process.env.BEHANCE_PASSWORD || "";
const TEST_TAGS = ["ai", "automation", "speedbots"]; // user's failing input: 3 words, must stay 3 separate tags

const input = {
  title: "AI Automation — Multi-Tag Verify",
  category: "branding",
  tags: TEST_TAGS,
  visibility: "public",
  description: "Multi-tag verification post for the backlink automator. AI automation for Coimbatore businesses — streamlining invoicing, CRM, and repetitive workflows so teams focus on growth.",
  shortDescription: "Multi-tag verification.",
  backlinkUrl: "https://speedbots.io/AI-Invoicing-Automation",
  imagePath: path.join(ROOT, "cover.jpg"),
  keyword: "",
  reviewPublish: false, // real publish so we can read the LIVE project tags
  credentials: { username: email, email, password },
};

const storedAccount = readSessionAccount();
const resolve = resolveStoredSession({ providedEmail: email, storedAccount, forceFresh: false });

const browser = await launchBrowser();
const { page, context } = await newPage(browser, {
  storageState: resolve.replay && fs.existsSync(config.browser.storageState) ? config.browser.storageState : undefined,
});
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});
setTimeout(() => process.exit(2), 6 * 60_000).unref();

await page.goto("https://www.behance.net/", { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(3000);
if (!(await isLoggedIn(page))) { console.error("NOT logged in"); process.exit(1); }

const wf = JSON.parse(fs.readFileSync(WF, "utf8"));
const result = await executeWorkflow({ workflow: wf, input, page });
await persistSession(context, { email, siteName: "behance" }).catch(() => {});

console.log("\n--- step results ---");
for (const r of result.results) {
  const state = r.skipped ? "skip" : r.failed ? "FAIL" : "ok";
  console.log(` [${state}] ${r.stepId}  ${r.action}${r.error ? "  -> " + r.error : ""}`);
}
console.log("\npublishedUrl :", result.publishedUrl || "(none)");
console.log("failures     :", result.failures.length ? result.failures.join(", ") : "(none)");

await closeBrowser(browser);

// Read the LIVE project's tags from the published page.
const url = result.publishedUrl;
let tags = [];
if (url) {
  try {
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0", "accept-language": "en" }, signal: AbortSignal.timeout(30000) });
    const html = await res.text();
    const m = html.match(/<meta[^>]+name=["']keywords["'][^>]+content=["']([^"']+)["']/i);
    if (m) tags = m[1].split(",").map((t) => t.trim()).filter(Boolean);
    else {
      const js = html.match(/window\.__BEHANCE_INITIAL_STATE__\s*=\s*({.+?})<\/script>/s) || html.match(/"tags":\[[^\]]*\]/g);
      if (js && js[1]) {
        const mm = js[1].match(/"tags":\[([^\]]*)\]/);
        if (mm) tags = mm[1].split(",").map((t) => t.replace(/"/g, "").trim()).filter(Boolean);
      }
      const mm = html.match(/"tags":\[([^\]]*)\]/g);
      if (!tags.length && mm) tags = mm.slice(-1)[0].match(/"([^"]+)"/g).map((t) => t.replace(/"/g, "").trim());
    }
  } catch (e) {
    console.log("fetch published page failed:", e.message);
  }
}

console.log("\n=== RESULT ===");
console.log("intended              :", JSON.stringify(TEST_TAGS));
console.log("tags on LIVE project  :", JSON.stringify(tags));
const allLand = TEST_TAGS.length > 0 && TEST_TAGS.every((t) => tags.some((g) => g.toLowerCase() === t.toLowerCase()));
console.log("EVERY tag landed?     :", allLand ? "YES" : "NO");
process.exit(allLand ? 0 : 1);