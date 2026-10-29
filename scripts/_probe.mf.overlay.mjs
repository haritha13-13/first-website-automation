#!/usr/bin/env node
import fs from "node:fs";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity } from "../src/browser/browser.js";
import { loadEnv } from "../src/common/env.js";

loadEnv();
const ROOT = "/home/haritha_13/behance-backlink-automator";

const browser = await launchBrowser();
const { page, context } = await newPage(browser, {
  storageState: fs.existsSync(ROOT + "/data/session.json") ? ROOT + "/data/session.json" : undefined,
});
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});

await page.goto("https://app.mediafire.com/folder/myfiles", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(12000);

const info = await page.evaluate(() => {
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(e).display !== "none"; };
  const btn = [...document.querySelectorAll("button,[role='button']")].find((b) => /upload files/i.test(b.getAttribute("aria-label") || ""));
  let blocker = null, blockerPath = "";
  if (btn) {
    const r = btn.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    blocker = el ? { tag: el.tagName, cls: (el.className + "").slice(0, 60), text: (el.textContent || "").trim().slice(0, 40) } : null;
    let p = el; const path = [];
    for (let i = 0; i < 6 && p; i++) { path.push(p.tagName + "." + (p.className + "").slice(0, 30)); p = p.parentElement; }
    blockerPath = path.join(" < ");
  }
  // dialogs / banners / high z-index overlays
  const overlayish = [...document.querySelectorAll("div,section,aside,[role='dialog']")]
    .filter((e) => { const s = getComputedStyle(e); const z = parseInt(s.zIndex || "0", 10); return vis(e) && (z >= 100 || /modal|overlay|backdrop|banner|consent|popup|dialog/i.test(e.className + "")); })
    .slice(0, 10)
    .map((e) => ({ tag: e.tagName, cls: (e.className + "").slice(0, 50), z: getComputedStyle(e).zIndex, text: (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60) }));
  const closeish = [...document.querySelectorAll("button")].filter(vis).map((b) => (b.getAttribute("aria-label") || b.textContent || "").trim()).filter((t) => /close|accept|got it|dismiss|no thanks|maybe later|ok/i.test(t)).slice(0, 10);
  const fileInputs = [...document.querySelectorAll("input[type=file]")].length;
  return { uploadBtnFound: !!btn, blocker, blockerPath, overlayish, closeish, fileInputs };
});
console.log(JSON.stringify(info, null, 1));

console.log("\n--- try force-click Upload files ---");
const clicked = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button,[role='button']")].find((b) => /upload files/i.test(b.getAttribute("aria-label") || ""));
  if (btn) { btn.click(); return true; }
  return false;
}).catch(() => false);
console.log("clicked:", clicked);
await page.waitForTimeout(3000);
const after = await page.evaluate(() => ({
  fileInputs: [...document.querySelectorAll("input[type=file]")].map((i) => ({ vis: (i.getBoundingClientRect().width > 2) })),
  dialogs: [...document.querySelectorAll("[role=dialog], [class*='modal']")].filter((e) => e.getBoundingClientRect().width > 2).map((e) => (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80)),
}));
console.log("after upload-click:", JSON.stringify(after, null, 1));

await closeBrowser(browser);
process.exit(0);