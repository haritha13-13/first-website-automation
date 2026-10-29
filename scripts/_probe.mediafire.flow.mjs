#!/usr/bin/env node
/**
 * Probe MediaFire upload dialog + share-link/copy-link flow (with stored session).
 *
 * Usage: node scripts/_probe.mediafire.flow.mjs
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
const browser = await launchBrowser();
const { page, context } = await newPage(browser, {
  storageState: fs.existsSync(storageState) ? storageState : undefined,
});
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});

logSection("Probe: MediaFire Upload flow");
await page.goto("https://app.mediafire.com/folder/myfiles", { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(4000);

// 1) Click Upload files
const uploadBtn = page.locator('button[aria-label="Upload files"]').first();
console.log("upload button count:", await uploadBtn.count());
if (await uploadBtn.count()) {
  await uploadBtn.click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(3500);
  console.log("url after upload click:", page.url());
  const dlg = await page.evaluate(() => {
    const btn = (b) => (b.getAttribute("aria-label") || (b.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40));
    const buttons = [...document.querySelectorAll("button")].map(btn).filter(Boolean).slice(0, 40);
    const inputs = [...document.querySelectorAll("input")].map((i) => ({ type: i.type, name: i.name, accept: i.accept, cls: i.className ? String(i.className).slice(0, 60) : "" }));
    const modals = [...document.querySelectorAll("[role='dialog'], [role='menu'], header h1, .r-1wzrnnt, [class*='Modal'], [class*='modal']")].map((m) => ({
      tag: m.tagName, role: m.getAttribute("role"), cls: String(m.className).slice(0, 60),
      text: (m.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120),
    })).slice(0, 20);
    return { buttons, inputs, modals };
  });
  console.log("\n--- dialog buttons ---");
  for (const b of dlg.buttons) console.log(b);
  console.log("\n--- inputs (incl file) ---");
  for (const i of dlg.inputs) console.log(JSON.stringify(i));
  console.log("\n--- modals/dialogs ---");
  for (const m of dlg.modals) console.log(JSON.stringify(m));

  // 2) Try dumping the share-link of an existing file: click a "Copy share link" and
  //    capture clipboard / dialog
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(1200);
  const copyLink = page.locator('button[aria-label="Copy share link"]').first();
  const copyCount = await copyLink.count();
  console.log("\ncopy share link buttons:", copyCount);
  if (copyCount) {
    await copyLink.click({ timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const after = await page.evaluate(() => {
      const dialogs = [...document.querySelectorAll("[role='dialog'], [role='menu'], [class*='modal' i], [class*='Modal']")].map((m) => ({
        role: m.getAttribute("role"), cls: String(m.className).slice(0, 60),
        text: (m.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200),
      })).filter((m) => m.text);
      return dialogs;
    });
    console.log("\n--- after copy click ---");
    for (const d of after) console.log(JSON.stringify(d));
    const links = await page.evaluate(() =>
      [...document.querySelectorAll("a[href*='mediafire.com/file'], a[href*='/file/']")].map((a) => a.getAttribute("href"))
    );
    console.log("file links on page:", links.slice(0, 10));
    const copyInput = await page.locator("input[readonly], input[value*='mediafire.com']").count().catch(() => 0);
    console.log("readonly/copy inputs:", copyInput);
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 800));
    console.log("body text snippet:\n", bodyText);
  }
} else {
  warn("No Upload button found.");
}

await closeBrowser(browser);
process.exit(0);