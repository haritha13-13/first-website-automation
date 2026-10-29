#!/usr/bin/env node
/**
 * Discovery-only run for MediaFire (anonymous upload -> share link).
 * Drives the browser agent's runDiscovery directly (no interactive prompts).
 *
 * Usage: node scripts/discover.mediafire.mjs
 */
import { runDiscovery } from "../src/workflow/agent.js";
import { loadEnv } from "../src/common/env.js";
import { config } from "../src/config.js";
import { logSection } from "../src/common/util.js";

loadEnv();

logSection("MediaFire Discovery");
console.log("headless:", config.browser.headless, "(AUTOMATOR_HEADLESS=" + process.env.AUTOMATOR_HEADLESS + ")");

const result = await runDiscovery({
  siteUrl: "https://www.mediafire.com/",
  siteName: "MediaFire",
  credentials: {
    email: process.env.MEDIAFIRE_EMAIL || process.env.BEHANCE_EMAIL || "",
    password: process.env.MEDIAFIRE_PASSWORD || process.env.BEHANCE_PASSWORD || "",
  },
});

console.log("\n--- discovery result ---");
console.log("file :", result.file);
console.log("partial:", result.partial);
process.exit(result.partial ? 1 : 0);