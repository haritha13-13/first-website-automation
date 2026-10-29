#!/usr/bin/env node
/**
 * Probe MediaFire END-TO-END upload: open uploader, set files on the file input,
 * start upload, wait for completion, then grab the share link / file row URL.
 *
 * Usage: node scripts/_probe.mediafire.upload.mjs [filePath]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity } from "../src/browser/browser.js";
import { loadEnv } from "../src/common/env.js";
import { logSection, ok, warn } from "../src/common/util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
loadEnv();

const storageState = path.join(ROOT, "data/session.json");
const file = process.argv[2] || path.join(ROOT, "scripts/fixtures/mediafire-probe.txt");
if (!fs.existsSync(file)) {
  fs.writeFileSync(file, "MediaFire probe file – not a real post.\n");
}
console.log("upload file:", file);

const browser = await launchBrowser();
const { page, context } = await newPage(browser, {
  storageState: fs.existsSync(storageState) ? storageState : undefined,
});
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});

logSection("Probe: MediaFire full upload");
await page.goto("https://app.mediafire.com/folder/myfiles", { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(4000);

const uploadBtn = page.locator('button[aria-label="Upload files"]').first();
await uploadBtn.click({ timeout: 8000 }).catch(() => {});
await page.waitForTimeout(2500);

// Set the file on whichever file input is the "upload files" one (drawer is open)
const fileInputs = page.locator("input[type='file']");
const n = await fileInputs.count();
console.log("file inputs visible:", n);
await fileInputs.first().setInputFiles(file).catch(async (e) => {
  warn("setInputFiles error: " + e.message);
});

await page.waitForTimeout(2500);

// Start upload
const startBtns = await page.evaluate(() =>
  [...document.querySelectorAll("button")].map((b) => (b.textContent || "").trim().replace(/\s+/g, " ").slice(0, 30))
    .filter((t) => /start upload|upload/i.test(t))
);
console.log("upload candidate buttons:", startBtns);
const start = page.getByRole("button", { name: /start upload/i, exact: false }).first();
if (await start.count().catch(() => 0)) {
  await start.click({ timeout: 6000 }).catch(() => {});
}

logSection("Waiting for upload to finish (up to 90s)");
const deadline = Date.now() + 90_000;
let fileRow = null;
while (Date.now() < deadline) {
  await page.waitForTimeout(4000);
  const name = path.basename(file);
  const state = await page.evaluate((nm) => {
    const text = document.body.innerText;
    const found = text.includes(nm);
    const rows = [...document.querySelectorAll("button[aria-label='Copy share link']")].length;
    const dialogs = [...document.querySelectorAll("[role='dialog']")].map((d) => (d.textContent || "").trim().replace(/\s+/g, " ").slice(0, 160)).filter(Boolean);
    return { found, rowCount: rows, dialogs };
  }, name);
  console.log("t+", (Date.now() - (Date.now() - 30000)) , "found:", state.found, "copy-link rows:", state.rowCount, state.dialogs.length ? "dialogs:\n" + state.dialogs.join("\n") : "");
  if (state.found && state.rowCount > 0) { fileRow = true; break; }
  // maybe upload completes and shows a dialog with the link
  if (state.dialogs.length) { fileRow = state.dialogs; break; }
}

console.log("\nfinal url:", page.url());

// Try to capture the share link by clicking Copy share link on the FIRST row
const copyLink = page.locator('button[aria-label="Copy share link"]').first();
if (await copyLink.count().catch(() => 0)) {
  await copyLink.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1800);
  const clipboard = await page.evaluate(() => navigator.clipboard.readText().catch(() => "")).catch(() => "");
  console.log("clipboard:", clipboard);
  const pageLinks = await page.evaluate(() => [...document.querySelectorAll("a[href*='/file/']")].map((a) => a.getAttribute("href")));
  console.log("file anchor hrefs:", pageLinks.slice(0, 5));
  const dialog = await page.evaluate(() =>
    [...document.querySelectorAll("[role='dialog'], [class*='modal' i]")].map((d) => ({ cls: String(d.className).slice(0, 40), text: (d.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200) })).filter((d) => d.text).slice(0, 3)
  );
  console.log("dialog:", JSON.stringify(dialog));
}

await context.storageState({ path: storageState }).catch(() => {});
await closeBrowser(browser);
process.exit(0);