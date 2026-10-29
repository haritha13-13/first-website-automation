#!/usr/bin/env node
/**
 * Discovery-only run for JumpShare (upload a document/file -> share link).
 * Drives the browser agent's runDiscovery directly (no interactive prompts).
 *
 * Usage: AUTOMATOR_HEADLESS=0 node scripts/discover.jumpshare.mjs
 */
import { runDiscovery } from "../src/workflow/agent.js";
import { loadEnv } from "../src/common/env.js";
import { config } from "../src/config.js";
import { logSection } from "../src/common/util.js";

loadEnv();

logSection("JumpShare Discovery");
console.log("headless:", config.browser.headless, "(AUTOMATOR_HEADLESS=" + process.env.AUTOMATOR_HEADLESS + ")");

const email = "speedbotsdm@gmail.com";
const password = "speedbotsdm@2025";

const result = await runDiscovery({
  siteUrl: "https://jumpshare.com/",
  siteName: "jumpshare",
  credentials: { email, password },
});

console.log("\n--- discovery result ---");
console.log("file  :", result.file);
console.log("partial:", result.partial);
if (result.partial) {
  console.log("Discovery did not fully complete — the partial workflow was saved for review.");
}
process.exit(result.partial ? 1 : 0);