#!/usr/bin/env node
/**
 * Probe: get MediaFire share link via clipboard (grant permissions).
 * Also try the per-row context menu -> "Copy link"/"Share" items.
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
// clipboard read/write needs permission (page uses https)
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://app.mediafire.com" }).catch((e) => console.log("grant err:", e.message));
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});

logSection("My Files");
await page.goto("https://app.mediafire.com/folder/myfiles", { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(4500);

const rowStructure = await page.evaluate(() => {
  // find rows with "Copy share link"
  const btns = [...document.querySelectorAll('button[aria-label="Copy share link"]')];
  return btns.slice(0, 2).map((b) => {
    let row = b;
    for (let i = 0; i < 6 && row; i++) row = row.parentElement;
    return {
      tag: row ? row.tagName : null,
      cls: row ? String(row.className).slice(0, 80) : null,
      text: row ? (row.textContent || "").replace(/\s+/g, " ").slice(0, 200) : null,
    };
  });
});
console.log("first rows:", JSON.stringify(rowStructure, null, 2));

const copyBtn = page.locator('button[aria-label="Copy share link"]').first();
if (await copyBtn.count()) {
  await copyBtn.click({ timeout: 5000 }).catch((e) => console.log("click err:", e.message.slice(0, 100)));
  await page.waitForTimeout(1500);
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch((e) => "ERR:" + e.message)).catch((e) => "JSErr:" + e.message);
  console.log("clipboard:", clip);
}

// Context menu route: open per-row menu, list items
await page.keyboard.press("Escape").catch(() => {});
await page.waitForTimeout(800);
const menuBtn = page.locator('button[aria-label="Open context menu"]').first();
if (await menuBtn.count()) {
  await menuBtn.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const items = await page.evaluate(() =>
    [...document.querySelectorAll("[role='menuitem'], [role='menu'] button, [role='menu'] div")].map((m) => (m.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60)).filter(Boolean).slice(0, 30)
  );
  console.log("\ncontext menu items:", items);
}

await closeBrowser(browser);
process.exit(0);