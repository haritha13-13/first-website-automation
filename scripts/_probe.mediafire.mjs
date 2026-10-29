#!/usr/bin/env node
/**
 * Probe MediaFire app UI (My Files, Upload, Share/Copy-link dialogs) with the
 * stored session, so the workflow can be built with REAL selectors.
 *
 * Usage: node scripts/_probe.mediafire.mjs
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

logSection("Probe: MediaFire My Files");
await page.goto("https://app.mediafire.com/folder/myfiles", { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(5000);
logSection("Target page");
console.log("url:", page.url());

const dump = await page.evaluate(() => {
  const describe = (el) => {
    const r = el.getBoundingClientRect();
    const visible = r.width > 0 && r.height > 0;
    return {
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type"),
      id: el.id,
      cls: (el.className && typeof el.className === "string" ? el.className : "").slice(0, 80),
      aria: el.getAttribute("aria-label"),
      text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60),
      sel: el.getAttribute ? el.getAttribute("data-testid") : null,
      visible,
    };
  };
  const inputs = [...document.querySelectorAll("input, textarea, [contenteditable='true']")].map(describe);
  const buttons = [...document.querySelectorAll("button, a, [role='button']")].map(describe).filter((b) => b.visible);
  const uploadInputs = inputs.filter((i) => i.type === "file");
  return {
    inputs: inputs.filter((i) => i.visible && (i.type !== "hidden" || i.type === "file")),
    uploadInputs,
    buttons: buttons.slice(0, 80),
    bodyClasses: [...document.body.classList].slice(0, 20),
  };
});
console.log("\n--- upload file inputs ---");
console.log(JSON.stringify(dump.uploadInputs, null, 2));
console.log("\n--- visible inputs ---");
console.log(JSON.stringify(dump.inputs, null, 2));
console.log("\n--- buttons (first 80) ---");
for (const b of dump.buttons) console.log(`${b.visible ? "" : "(hidden) "}${b.tag}${b.type ? "[" + b.type + "]" : ""} aria=${b.aria || "-"} text=${JSON.stringify(b.text)} cls=${b.cls} testid=${b.sel || "-"}`);

await closeBrowser(browser);
process.exit(0);