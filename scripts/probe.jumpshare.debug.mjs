#!/usr/bin/env node
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
page.on("framenavigated", (f) => { if (f === page.mainFrame()) console.log("NAV", f.url()); });
setTimeout(() => process.exit(2), 70000).unref();

await page.goto("https://jumpshare.com/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(9000);
const d = await page.evaluate(() => {
  const all = [...document.querySelectorAll("a")].filter((a) => /\/share\//.test(a.href)).map((a) => ({ cls: (a.className + "").slice(0, 40), href: a.href.slice(0, 60), title: (a.getAttribute("title") || "").slice(0, 30), text: (a.textContent || "").trim().slice(0, 30) }));
  const thumbs = [...document.querySelectorAll("a.thumb-title")].map((a) => ({ href: a.href, title: a.getAttribute("title"), text: (a.textContent || "").trim() }));
  return { url: location.href, shareAnchors: all.slice(0, 8), thumbTitles: thumbs.slice(0, 8), hasUploadInput: !!document.querySelector("#_upload_input") };
});
console.log(JSON.stringify(d, null, 1));
await closeBrowser(browser);
process.exit(0);