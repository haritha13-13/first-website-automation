#!/usr/bin/env node
import fs from "node:fs";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity } from "../src/browser/browser.js";
import { loadEnv } from "../src/common/env.js";
loadEnv();
const ROOT = "/home/haritha_13/behance-backlink-automator";
const DOC = process.env.DOCHUB_DOC || "/mnt/c/Users/haris/Downloads/accounting-automation (1).docx";

const browser = await launchBrowser();
const { page, context } = await newPage(browser, {
  storageState: fs.existsSync(ROOT + "/data/session.json") ? ROOT + "/data/session.json" : undefined,
});
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});

await page.goto("https://dochub.com/new", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(8000);
await page.locator("input[type=file]").first().setInputFiles(DOC).catch((e) => console.log("upload err:", e.message));

for (let i = 0; i < 4; i++) {
  await page.waitForTimeout(5000);
  const info = await page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
    const btn = [...document.querySelectorAll("button,a,[role=button]")].find((b) => /^create document$/i.test((b.textContent || "").trim()) && vis(b));
    let panel = btn;
    for (let i = 0; i < 6 && panel && panel.parentElement; i++) {
      if (/max-w-4xl|@container|flex-col/.test(panel.className + "") && (panel.textContent || "").length > 100) break;
      panel = panel.parentElement;
    }
    panel = panel || btn?.parentElement;
    const controls = panel ? [...panel.querySelectorAll("input,select,textarea,label,[role=checkbox],[role=switch]")].map((c) => ({
      tag: c.tagName, type: c.type || c.getAttribute("role") || "", name: c.name || "", id: c.id || "",
      value: c.value || "", checked: c.checked, disabled: c.disabled,
      label: (c.closest("label")?.textContent || c.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 50),
    })) : [];
    return {
      disabled: btn ? (btn.disabled || btn.getAttribute("aria-disabled")) : null,
      panelText: panel ? (panel.innerText || "").replace(/\n+/g, " | ").slice(0, 500) : "",
      controls,
    };
  });
  console.log(`\n=== +${(i + 1) * 5}s ===`);
  console.log("btn disabled:", info.disabled);
  console.log("panel:", info.panelText);
  console.log("controls:", JSON.stringify(info.controls));
}

await context.storageState({ path: ROOT + "/data/session.json" }).catch(() => {});
await closeBrowser(browser);
process.exit(0);