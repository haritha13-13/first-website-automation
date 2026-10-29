#!/usr/bin/env node
import fs from "node:fs";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity } from "/home/haritha_13/behance-backlink-automator/src/browser/browser.js";
import { loadEnv } from "/home/haritha_13/behance-backlink-automator/src/common/env.js";
loadEnv();
const ROOT = "/home/haritha_13/behance-backlink-automator";
const PROJECT = "https://www.behance.net/gallery/256459685/AI-Automation-Multi-Tag-Verify";
const browser = await launchBrowser();
const { page, context } = await newPage(browser, {
  storageState: fs.existsSync(ROOT + "/data/session.json") ? ROOT + "/data/session.json" : undefined,
});
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});
setTimeout(() => process.exit(2), 90000).unref();

let d = {};
try {
  await page.goto(PROJECT, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(8000);
  d = await page.evaluate(() => {
    const kw = document.querySelector('meta[name="keywords"]');
    const tagLinks = [...document.querySelectorAll("a[href*='/tags/'], a[href*='/search/'], [data-testid*='tag'], .tags a")].map((a) => (a.textContent || "").trim()).filter((t) => t && t.length < 40);
    const json = document.body.innerHTML.match(/"tags":\[[^\]]*\]/g);
    const title = document.title;
    return { title, metaKeywords: kw ? kw.content : "", tagLinks: [...new Set(tagLinks)].slice(0, 20), url: location.href, jsonTags: json ? json.slice(-2) : [] };
  });
} catch (e) { d = { err: e.message }; }
console.log(JSON.stringify(d, null, 1));
await closeBrowser(browser);
process.exit(0);