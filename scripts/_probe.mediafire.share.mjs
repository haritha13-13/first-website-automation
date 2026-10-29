#!/usr/bin/env node
/**
 * Quick probe: is "mediafire-probe.txt" in My Files now? If yes, click its
 * "Copy share link" and read the URL anchor of the file row / dialog.
 * No clipboard prompt — read the link from DOM/network instead.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity } from "../src/browser/browser.js";
import { loadEnv } from "../src/common/env.js";
import { logSection } from "../src/common/util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
loadEnv();
const storageState = path.join(ROOT, "data/session.json");

const browser = await launchBrowser();
const { page, context } = await newPage(browser, { storageState: storageState });
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});

logSection("Check My Files for probe file");
await page.goto("https://app.mediafire.com/folder/myfiles", { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(4500);

const info = await page.evaluate(() => {
  const text = document.body.innerText;
  const present = text.includes("mediafire-probe.txt");
  // capture any visible file rows: find anchors to /file/ or buttons
  const anchors = [...document.querySelectorAll("a")].map((a) => ({ href: a.getAttribute("href"), text: (a.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60) }))
    .filter((a) => a.href && /app\.mediafire\.com\//.test(a.href) && a.text).slice(0, 40);
  return { present, anchors };
});
console.log("probe file present:", info.present);
console.log("\nanchors:");
for (const a of info.anchors) console.log(JSON.stringify(a));

logSection("Intercept network for the share-link call");
const captured = [];
const onResp = (res) => {
  const u = res.url();
  if (/share|link|file\/|getlink|copylink/i.test(u)) captured.push([res.request().method(), u]);
};
page.on("response", onResp);

// Open context menu on the first file row (data rows) and click "Copy link"
const copyBtn = page.locator('button[aria-label="Copy share link"]').first();
const cnt = await copyBtn.count();
console.log("\ncopy share link buttons:", cnt);
if (cnt) {
  await copyBtn.click({ timeout: 5000 }).catch((e) => console.log("copy click err", e.message.slice(0, 120)));
  await page.waitForTimeout(2500);
  const dialogs = await page.evaluate(() =>
    [...document.querySelectorAll("[role='dialog'], [class*='modal' i]")].map((d) => ({
      role: d.getAttribute("role"), cls: String(d.className).slice(0, 40),
      text: (d.textContent || "").trim().replace(/\s+/g, " ").slice(0, 300),
    })).filter((d) => d.text).slice(-3)
  );
  console.log("\ndialogs after copy click:");
  for (const d of dialogs) console.log(JSON.stringify(d));
}
console.log("\nshare-link network calls:");
for (const [m, u] of captured) console.log(m, u);

await closeBrowser(browser);
process.exit(0);