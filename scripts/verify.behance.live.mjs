#!/usr/bin/env node
/**
 * Verify the LIVE published Behance gallery page through the authenticated
 * session: read meta keywords + tag links. Usage:
 *   AUTOMATOR_HEADLESS=0 node scripts/verify.behance.live.mjs <gallery-url>
 */
import { chromium } from "playwright";
import fs from "node:fs";
import { loadEnv } from "../src/common/env.js";
import { config } from "../src/config.js";

loadEnv();
const url = process.argv[2];
if (!url) {
  console.error("usage: node scripts/verify.behance.live.mjs <gallery-url>");
  process.exit(2);
}
const session = fs.existsSync(config.browser.storageState)
  ? JSON.parse(fs.readFileSync(config.browser.storageState, "utf8"))
  : null;

const browser = await chromium.launch({ headless: process.env.AUTOMATOR_HEADLESS === "0" ? false : true });
const ctx = await browser.newContext({
  ...(session ? { storageState: session } : {}),
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  viewport: { width: 1440, height: 900 },
});
const page = await ctx.newPage();
await page.goto(url.replace(/\?share=1$/, ""), { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(4000);

const data = await page
  .evaluate(() => {
    const meta = [...document.querySelectorAll('meta[name="keywords"]')].map((m) => m.getAttribute("content") || "");
    const tagLinks = [...document.querySelectorAll('a[href*="/tags/"], a[href*="projects/tags"]')]
      .map((a) => ({ text: (a.textContent || "").trim(), href: a.getAttribute("href") }))
      .filter((t) => t.text)
      .slice(0, 30);
    return { title: (document.querySelector("h1, [itemprop='name']") || {}).textContent || "", metaKeywords: meta, tagLinks };
  })
  .catch((e) => ({ err: e.message }));

console.log(JSON.stringify(data, null, 1));

const chips = [
  ...(data.metaKeywords || []).join(",").split(","),
  ...(data.tagLinks || []).map((t) => t.text),
].map((c) => c.toLowerCase().trim()).filter(Boolean);
const checks = ["ai", "automation", "speedbots"].map((w) => ({ word: w, present: chips.includes(w) }));
console.log("--- check ---");
for (const c of checks) console.log(`${c.word} -> ${c.present ? "PRESENT" : "MISSING"}`);
console.log("ALL THREE SEPARATE?:", checks.every((c) => c.present) ? "YES" : "NO");
await browser.close();
process.exit(checks.every((c) => c.present) ? 0 : 1);