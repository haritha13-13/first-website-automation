#!/usr/bin/env node
/**
 * Live Behance tags test: fills the publish dialog with MULTIPLE tags in
 * review mode (stops before final Publish), then reads back the committed
 * tag chips from the dialog DOM to confirm EVERY tag landed.
 *
 * Usage: AUTOMATOR_HEADLESS=0 node scripts/test.behance.tags.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity, readSessionAccount, resolveStoredSession } from "../src/browser/browser.js";
import { executeWorkflow } from "../src/workflow/engine.js";
import { isLoggedIn } from "../src/workflow/agent.js";
import { loadEnv } from "../src/common/env.js";
import { config } from "../src/config.js";
import { logSection } from "../src/common/util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WF = path.join(ROOT, "workflows", "behance-net.workflow.json");
loadEnv();

const email = "speedbotsdm@gmail.com";
const password = process.env.BEHANCE_PASSWORD || "";

const input = {
  title: "AI Automation Tag Test",
  category: "branding",
  tags: ["ai", "automation", "speedbots"], // user's exact failing input
  visibility: "public",
  description: "AI automation tag fix verification test.",
  shortDescription: "Multi-tag verification.",
  backlinkUrl: "https://speedbots.io/AI-Invoicing-Automation",
  imagePath: path.join(ROOT, "cover.jpg"),
  keyword: "",
  reviewPublish: true, // fill dialog, then STOP — never publish
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
if (await isLoggedIn(page)) logSection("Stored session is logged in — running workflow");
else { console.error("NOT logged in — cannot test publish dialog"); process.exit(1); }

const wf = JSON.parse(fs.readFileSync(WF, "utf8"));
const result = await executeWorkflow({ workflow: wf, input, page });

console.log("\n--- step results ---");
for (const r of result.results) {
  const state = r.skipped ? "skip" : r.failed ? "FAIL" : "ok";
  console.log(` [${state}] ${r.stepId}  ${r.action}${r.error ? "  -> " + r.error : ""}${r.failed ? "" : ""}`);
}
console.log("\nfailures:", result.failures.length ? result.failures.join(", ") : "(none)");

await page.waitForTimeout(1500);
const tags = await page.evaluate(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4 && getComputedStyle(e).display !== "none"; };
  const result = { url: location.href, components: [] };
  for (const comp of [...document.querySelectorAll(".vue-tags-input, .ti-input")].filter(vis)) {
    const ul = comp.querySelector("ul.ti-tags, [class*='ti-tags']");
    const chips = ul
      ? [...ul.querySelectorAll("li")].map((li) => (li.textContent || "").trim()).filter(Boolean)
      : [];
    const rawInput = [...comp.querySelectorAll("input")].map((i) => i.value).join("|");
    const ph = [...comp.querySelectorAll("input")].map((i) => i.getAttribute("placeholder") || "").join("|");
    result.components.push({
      cls: (comp.className + "").slice(0, 45),
      chips,
      rawInput,
      ph,
    });
  }
  const merged = result.components.flatMap((c) => c.chips)
    .filter((t) => t.split(/\s+/).length > 1 && /^[a-z]+ [a-z]+$/.test(t));
  result.anySuspiciousMultiWordChip = merged;
  return result;
}).catch((e) => ({ err: e.message }));

console.log("\n--- TAG CHIPS IN DIALOG (per component) ---");
console.log(JSON.stringify(tags, null, 1));

await closeBrowser(browser);
process.exit(0);