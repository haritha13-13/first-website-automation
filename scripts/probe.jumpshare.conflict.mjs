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
setTimeout(() => process.exit(2), 100000).unref();

await page.goto("https://jumpshare.com/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(7000);
console.log("URL1:", await page.evaluate(() => location.href));

const file = "/mnt/c/Users/haris/Downloads/ai-automation (1).docx"; // already in library -> conflict
await page.locator("#_upload_input").setInputFiles(file);
await page.waitForTimeout(10000);

const snap = () => page.evaluate(() => {
  const visibleText = [...document.querySelectorAll("button,a,[role='button'],[tabindex]")].filter((e) => e.offsetWidth > 0 && (e.textContent || "").trim().length < 60).map((e) => ({ tag: e.tagName, cls: ((e.className + "") || "").slice(0, 45), txt: (e.textContent || "").trim().replace(/\s+/g, " ").slice(0, 50) }));
  const dialogs = [...document.querySelectorAll("[role='dialog'],[class*='modal'],[class*='popup'],[class*='overlay'],[class*='confirm'],[class*='replace'],[class*='duplicate']")].filter((e) => e.offsetWidth > 0).map((e) => ({ cls: (e.className + "").slice(0, 50), txt: (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 250) }));
  const noThumbs = document.querySelectorAll("a.thumb-title").length;
  return { url: location.href, buttons: visibleText.filter((b) => /replace|duplicate|upload|new|cancel|copy|keep|overwrite/i.test(b.txt)).slice(0, 15), allButtons: visibleText.slice(0, 25), dialogs: dialogs.filter((d) => d.txt).slice(0, 8), thumbCount: noThumbs };
});

console.log("\n--- AFTER UPLOAD ---");
console.log(JSON.stringify(await snap(), null, 1));

process.exit(0);