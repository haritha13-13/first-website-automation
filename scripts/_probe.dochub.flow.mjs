#!/usr/bin/env node
import fs from "node:fs";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity } from "../src/browser/browser.js";
import { loadEnv } from "../src/common/env.js";
loadEnv();
const ROOT = "/home/haritha_13/behance-backlink-automator";
const DOC = process.env.DOCHUB_DOC || "/mnt/c/Users/haris/Downloads/accounting-automation (1).docx";

const dump = async (page, label) => {
  const d = await page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
    const inputs = [...document.querySelectorAll("input[type=file]")].map((i) => ({
      accept: i.getAttribute("accept"),
      multiple: i.multiple,
      vis: vis(i),
      container: (i.closest("label,div,form")?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
    }));
    const buttons = [...document.querySelectorAll("button,a,[role=button]")].filter(vis).map((b) => (b.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 30);
    return { url: location.href, inputs, buttons };
  }).catch((e) => ({ err: e.message }));
  console.log(`\n--- ${label} ---`);
  console.log(JSON.stringify(d, null, 1));
};

const browser = await launchBrowser();
const { page, context } = await newPage(browser, {
  storageState: fs.existsSync(ROOT + "/data/session.json") ? ROOT + "/data/session.json" : undefined,
});
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});

await page.goto("https://dochub.com/new", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(8000);
await dump(page, "before upload");

// choose the file input whose container mentions import/upload/choose/file, else first
const idx = await page.evaluate(() => {
  const ins = [...document.querySelectorAll("input[type=file]")];
  const rank = (i) => {
    const c = (i.closest("label,div,form")?.textContent || "").toLowerCase();
    let s = 0;
    if (i.accept && /docx|pdf|doc/.test(i.accept)) s += 2;
    if (/import|upload|choose|browse|drag/.test(c)) s += 3;
    return s;
  };
  let best = 0;
  ins.forEach((i, n) => { if (rank(i) > rank(ins[best])) best = n; });
  return best;
});
console.log("\nusing file input index:", idx);
await page.locator("input[type=file]").nth(idx).setInputFiles(DOC).catch((e) => console.log("upload err:", e.message));

for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(2500);
  await dump(page, `after upload +${(i + 1) * 2.5}s`);
}

await context.storageState({ path: ROOT + "/data/session.json" }).catch(() => {});
await closeBrowser(browser);
process.exit(0);