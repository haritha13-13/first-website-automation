#!/usr/bin/env node
/**
 * JumpShare app exploration: Personal Library UI — upload input, file rows,
 * share-link controls, and the URL pattern of a shared file.
 */
import fs from "node:fs";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity } from "/home/haritha_13/behance-backlink-automator/src/browser/browser.js";
import { loadEnv } from "/home/haritha_13/behance-backlink-automator/src/common/env.js";
loadEnv();
const ROOT = "/home/haritha_13/behance-backlink-automator";
const browser = await launchBrowser();
const { page, context } = await newPage(browser, {
  storageState: fs.existsSync(ROOT + "/data/session.json") ? ROOT + "/data/session.json" : undefined,
});
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});
page.on("framenavigated", (f) => { if (f === page.mainFrame()) console.log("   NAV ->", f.url()); });
setTimeout(() => process.exit(2), 90000).unref();

await page.goto("https://jumpshare.com/w/aa7ffd3/personal", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(8000);

const dump = await page.evaluate(() => ({
  url: location.href,
  text: (document.body?.innerText || "").replace(/\n{2,}/g, "\n").slice(-900),
  fileInputs: [...document.querySelectorAll("input[type=file]")].map((i) => ({ id: i.id, cls: (i.className + "").slice(0, 50), accept: (i.accept || "").slice(0, 60) })),
  navButtons: [...document.querySelectorAll("button, [role='button']")].map((b) => ({ t: (b.textContent || "").replace(/\s+/g, " ").trim().slice(0, 26), id: b.id, title: (b.title || "").slice(0, 24) })).filter((b) => b.t || b.title).slice(0, 40),
  shareAnchors: [...document.querySelectorAll("a")].map((a) => a.href || "").filter((h) => /jumpshare\.com\/(share|v|s)\//.test(h)).slice(0, 10),
  rows: [...document.querySelectorAll("tr, [class*='file' i], [class*='row' i]")].filter((e) => /docx|\.pdf|\.mp4|\.png/i.test(e.textContent || "") && (e.offsetWidth || e.offsetHeight)).map((e) => ({ t: (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60), cls: (e.className + "").slice(0, 40) })).slice(0, 6),
}));
console.log(JSON.stringify(dump, null, 1));
await closeBrowser(browser);
process.exit(0);