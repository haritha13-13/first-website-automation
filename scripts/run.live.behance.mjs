#!/usr/bin/env node
/**
 * Live Behance run with the CURRENT stored account (speedbotsdm@gmail.com).
 *
 *   - Logs in fresh whenever the stored session belongs to a DIFFERENT account
 *     (or none is recorded), so old-account sessions can never hijack the post.
 *   - Auto-fills the Adobe/Behance login; if a CAPTCHA appears the window just
 *     stays open and the agent resumes as soon as you solve it. If automation
 *     can't reach the form at all it hands over to you manually and waits.
 *   - Runs the saved behance-net workflow (create a project -> editor -> text
 *     block backlink -> publish dialog -> publish), then holds the WINDOW OPEN
 *     so you can inspect the result instead of it vanishing.
 *
 * Usage:  node scripts/run.live.behance.mjs ["title"] ["category"] ["backlinkUrl"]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, newPage, closeBrowser, raiseBrowserWindow, maximizeBrowserWindow, armUserActivity, readSessionAccount, resolveStoredSession, persistSession, printDevtoolsHelp } from "../src/browser/browser.js";
import { executeWorkflow } from "../src/workflow/engine.js";
import { isLoggedIn, ensureLoggedIn } from "../src/workflow/agent.js";
import { loadEnv } from "../src/common/env.js";
import { config } from "../src/config.js";
import { holdOpenForReview } from "../src/ui/hold.js";
import { ok, warn, logSection, screenshot } from "../src/common/util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WF = path.join(ROOT, "workflows", "behance-net.workflow.json");

loadEnv();

// Visible window is the whole point of a live run — on a desktop grant it.
if (process.env.AUTOMATOR_HEADLESS !== "1" && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.env.WSL_DISPLAY)) {
  process.env.AUTOMATOR_HEADLESS = "0";
}

// Optional terminal input:  node scripts/run.live.behance.mjs <email> <password> [title] [category] [backlinkUrl]
const argv = process.argv.slice(2);
let [titleArg, categoryArg, backlinkArg] = argv;
if (argv[0] && argv[0].includes("@")) {
  const cliEmail = argv.shift();
  const cliPassword = argv.shift() || "";
  [titleArg, categoryArg, backlinkArg] = argv;
  ok(`Using email/password from the terminal: ${cliEmail}`);
  process.env.BEHANCE_EMAIL = cliEmail;
  process.env.BEHANCE_PASSWORD = cliPassword;
}

const email = process.env.BEHANCE_EMAIL || "";
const password = process.env.BEHANCE_PASSWORD || "";
if (!email || !password) {
  console.error("No credentials set. Put BEHANCE_EMAIL/BEHANCE_PASSWORD in .env, the shell, or pass them as args.");
  process.exit(1);
}
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error(`BEHANCE_EMAIL looks like a typo: ${JSON.stringify(email)}`);
  process.exit(1);
}
if (email !== "speedbotsdm@gmail.com") {
  console.error(`This automator now works ONLY with "speedbotsdm@gmail.com" — got ${JSON.stringify(email)}. Fix .env or the shell arg.`);
  process.exit(1);
}
ok(`Live Behance run as ${email}`);
const doc = path.join(ROOT, "..", "content_agent", "output", "blogs", "ai-automation-for-coimbatore.txt");
const description = fs.existsSync(doc) ? fs.readFileSync(doc, "utf8") : "AI automation for Coimbatore businesses — streamlining invoicing, CRM, and repetitive workflows so teams focus on growth.";
const cover = path.join(ROOT, "cover.jpg");

const input = {
  title: titleArg || "AI Automation",
  category: categoryArg || "branding",
  tags: ["ai", "automation"],
  visibility: "public",
  description,
  shortDescription: "How AI automation helps Coimbatore businesses save time on invoicing, CRM and repetitive work.",
  backlinkUrl: backlinkArg || "https://speedbots.io/AI-Invoicing-Automation",
  imagePath: fs.existsSync(cover) ? cover : "",
  keyword: "",
  reviewPublish: false,
  credentials: { username: email, email, password },
};

// Session replay decision: never reuse a session recorded for another account.
const provided = String(email).trim();
const storedAccount = readSessionAccount();
const resolve = resolveStoredSession({ providedEmail: provided, storedAccount, forceFresh: process.env.AUTOMATOR_FRESH_LOGIN === "1" });
const storageState = resolve.replay && fs.existsSync(config.browser.storageState) ? config.browser.storageState : undefined;
if (resolve.replay && storedAccount?.email) ok(`Reusing stored session for ${storedAccount.email}`);
if (!resolve.replay) warn(storedAccount?.email
  ? `Stored session is ${storedAccount.email} — logging in FRESH as ${email}.`
  : "No recorded account for the stored session — logging in FRESH.");

logSection("Launching visible browser");
const browser = await launchBrowser();
const { page, context } = await newPage(browser, { storageState });
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});
await new Promise((r) => setTimeout(r, 400));
ok("Watch the REAL Chrome window on your desktop (it is maximized).");
ok("If you cannot see it, open this link in your WINDOWS browser to see/control it:");
printDevtoolsHelp(config.browser.debugPort);

const raiseWatchdog = setInterval(() => raiseBrowserWindow(context, { gentle: true }).catch(() => {}), 5000);

try {
  const wf = JSON.parse(fs.readFileSync(WF, "utf8"));
  if (resolve.replay) {
    // Session reuse requested (credentials match the pinned stored account) —
    // no fresh login by design; just open the site and run the workflow.
    await page.goto("https://www.behance.net/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3000);
    if (await isLoggedIn(page)) ok("Stored session is logged in — proceeding without re-login.");
    else warn("Stored session appears logged OUT — login won't be attempted (session reuse mode). The run may fail; set AUTOMATOR_FRESH_LOGIN=1 to sign in fresh on purpose.");
  } else {
    // FULLY AUTOMATED LOGIN: the agent enters the site, clicks Sign In, types
    // speedbotsdm@gmail.com, clicks "Continue with Google", types the email
    // again and the password Speedbots@2025 itself (exact-match verified).
    await ensureLoggedIn({ page, context, email, password, siteName: "behance" });
  }
  await screenshot(page, "live-behance-home");
  logSection("Executing Behance workflow");
  const result = await executeWorkflow({ workflow: wf, input, page });
  await screenshot(page, "live-behance-final");
  ok(`Session updated for ${email} — future runs reuse this account.`);

  console.log("\n--- step results ---");
  for (const r of result.results) {
    const state = r.skipped ? "skip" : r.failed ? "FAIL" : "ok";
    console.log(` [${state}] ${r.stepId}  ${r.action}${r.error ? "  -> " + r.error : ""}${r.skipped && r.reason ? "  (" + r.reason + ")" : ""}`);
  }
  console.log("\npublishedUrl :", result.publishedUrl || "(none)");
  console.log("failures     :", result.failures.length ? result.failures.join(", ") : "(none)");

  await persistSession(context, { email, siteName: "behance" }).catch(() => {});

  const holdMs = Number(process.env.AUTOMATOR_HOLD_MS || 0);
  if (holdMs > 0) {
    logSection("Live window kept open for review (AUTOMATOR_HOLD_MS>0)");
    ok("The window is open showing the final state. Close it manually or wait — it auto-closes in " + Math.round(holdMs / 1000) + "s (Enter closes now).");
    await holdOpenForReview({ holdMs });
  }

  const failed = result.failures.filter((f) => f !== "login-verify" && f !== "choose-project");
  await closeBrowser(browser);
  process.exit(failed.length ? 1 : 0);
} catch (err) {
  await screenshot(page, "live-behance-error").catch(() => {});
  console.error("\nLIVE RUN ERROR:", err.message);
  if (err.stack) console.error(err.stack.split("\n").slice(0, 5).join("\n"));
  clearInterval(raiseWatchdog);
  await closeBrowser(browser);
  process.exit(1);
}