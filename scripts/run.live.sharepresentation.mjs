#!/usr/bin/env node
/**
 * Live SharePresentation run (current account: speedbotsdm@gmail.com).
 *
 *   - Reuses the persistent Chrome profile (trusted Google device).
 *   - Clicking the site's Upload button opens the login modal when logged out;
 *     "Sign in with Google" starts OAuth. The agent types the account email +
 *     password on Google's page and handles the consent screen automatically.
 *     First sign-in may ask for a one-time confirmation code (in the Gmail
 *     inbox) — the window stays open and the run continues automatically.
 *   - Then uploads the blog document and runs the saved sharepresentation-com
 *     workflow (description, tags, category, title, publish) and captures the
 *     published presentation URL from /dashboard.
 *
 * Usage: node scripts/run.live.sharepresentation.mjs ["title"] ["category"]
 *        ["tags"] ["/path/to/document"] ["short description"]
 *        env: BEHANCE_EMAIL / BEHANCE_PASSWORD (same Google account)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity } from "../src/browser/browser.js";
import { executeWorkflow } from "../src/workflow/engine.js";
import { ensureGoogleSession } from "../src/workflow/agent.js";
import { loadEnv } from "../src/common/env.js";
import { logSection, ok, warn } from "../src/common/util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
loadEnv();

const [titleArg, categoryArg, tagsArg, docArg, descArg] = process.argv.slice(2);
const doc = docArg || "/home/haritha_13/content_agent/output/blogs/ai-automation-for-coimbatore.txt";
if (!fs.existsSync(doc)) { console.error("missing document:", doc); process.exit(1); }

const email = process.env.BEHANCE_EMAIL || "";
const password = process.env.BEHANCE_PASSWORD || "";
if (!email || !password) { console.error("set BEHANCE_EMAIL / BEHANCE_PASSWORD in .env"); process.exit(1); }

const input = {
  title: titleArg || "AI Automation",
  slug: "ai-automation",
  shortDescription: descArg || "AI Automation for Coimbatore: Benefits & Use Cases.",
  description: descArg || "AI Automation for Coimbatore: Benefits & Use Cases.",
  tags: (tagsArg || "ai,automation,backlinks").split(",").map((t) => t.trim()).filter(Boolean),
  category: categoryArg || "Technology",
  visibility: "public",
  bodyDocumentPath: doc,
  bodyDocumentTxtPath: doc,
  keyword: "",
  backlinkUrl: "",
  reviewPublish: false,
};

const browser = await launchBrowser();
const { page, context } = await newPage(browser, {});
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});

const siteOrigin = "https://www.sharepresentation.com";
logSection(`Signing into SharePresentation (${email})`);
await page.goto(siteOrigin + "/", { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(2500);

const clickedUpload = await page
  .evaluate(() => {
    const el = [...document.querySelectorAll("#uploadsession, a[href*='upload'], button")].find((e) => {
      const r = e.getBoundingClientRect();
      const label = ((e.getAttribute("aria-label") || "") + " " + (e.textContent || "")).toLowerCase();
      return r.width > 0 && r.height > 0 && (e.id === "uploadsession" || /upload/i.test(label));
    });
    if (el) { el.click(); return true; }
    return false;
  })
  .catch(() => false);
await page.waitForTimeout(2000);

const googleLinkVisible = await page
  .locator('a[href*="google/redirect"], button:has-text("Sign in with Google"), a:has-text("with Google")')
  .first()
  .isVisible()
  .catch(() => false);

let loggedIn = false;
if (!googleLinkVisible) {
  ok("No Google login link offered — session may already be active on the upload page.");
} else {
  ok("Found “Sign in with Google” — starting OAuth.");
  await page.locator('a[href*="google/redirect"], button:has-text("Sign in with Google"), a:has-text("with Google")').first().click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const oauth = await ensureGoogleSession({ page, context, email, password, siteOrigin });
  loggedIn = oauth.siteReturned;
  if (!loggedIn) warn(`Google sign-in not confirmed returned to the site yet (typed password: ${oauth.done}). Waiting briefly...`);
  // Give any OAuth popup/redirect a moment to close; re-check the main page.
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline && !loggedIn) {
    await page.goto(siteOrigin + "/", { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(2500);
    await maximizeBrowserWindow(context).catch(() => {});
    const nowOnUpload = (context.pages() || []).some((p) => /^https?:\/\/www\.sharepresentation\.com/.test(p.url()) && !/accounts\.google/.test(p.url()));
    loggedIn = nowOnUpload || (context.pages() || []).some((p) => /sharepresentation\.com\/upload|sharepresentation\.com\/dashboard/.test(p.url()));
  }
}

if (loggedIn) {
  ok("Logged in.");
} else {
  warn("Not logged in — attempting to run the workflow anyway (it may skip the form if the session is still closed).");
}

// The workflow's loginSteps apply to a FRESH session; here the runner already
// handled authentication, so disable the auth block to avoid re-triggering it.
const wf = JSON.parse(fs.readFileSync(path.join(ROOT, "workflows/sharepresentation-com.workflow.json"), "utf8"));
if (loggedIn) wf.auth = { required: false, loginSteps: [] };

logSection(`Running live publish on sharepresentation.com`);
const result = await executeWorkflow({ workflow: wf, input, page, context });

console.log("\n--- results ---");
for (const r of result.results) {
  const state = r.skipped ? "skip" : r.failed ? "FAIL" : "ok";
  console.log(` [${state}] ${r.stepId} ${r.action}${r.error ? " -> " + r.error : ""}${r.skipped && r.reason ? "  reason: " + r.reason : ""}`);
}
const failed = result.failures.filter((f) => f !== "login-verify");
let publishedUrl = result.publishedUrl;
console.log("\npublishedUrl:", publishedUrl);
console.log("failures:", result.failures.length ? result.failures.join(", ") : "(none)");

// SharePresentation lands on /dashboard after publishing; resolve the real
// .view-ppt link when the engine's capture didn't already produce one.
if (!publishedUrl || /sharepresentation\.com\/dashboard/.test(publishedUrl)) {
  const dash = await page.evaluate(() => {
    const link = [...document.querySelectorAll("a.view-ppt, a[href*='view']")].find((a) => {
      const h = a.getAttribute("href") || "";
      return /\/view\//.test(h) || /view-ppt/.test(a.className);
    });
    const row = [...document.querySelectorAll(".view-ppt")][0];
    const best = link || row;
    return best ? (best.getAttribute("href") || "") : "";
  }).catch(() => "");
  if (dash) {
    publishedUrl = new URL(dash, siteOrigin).toString();
    ok("Published presentation URL: " + publishedUrl);
  }
}

if (publishedUrl && /sharepresentation\.com/.test(publishedUrl)) {
  await context.storageState({ path: path.join(ROOT, "data/session.json") }).catch(() => {});
  console.log("session saved.");
} else {
  console.log("WARN: no published presentation URL captured.");
}

await closeBrowser(browser);
process.exit(failed.length ? 1 : 0);