#!/usr/bin/env node
/**
 * Dump the exact DOM of DocHub's Share dialog for an EXISTING document after
 * the account is verified — so I can write a precise link extractor.
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
setTimeout(() => process.exit(2), 100000).unref();

await page.goto("https://dochub.com/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
await page.waitForTimeout(6000);
const docUrl = await page.evaluate(() => {
  const a = [...document.querySelectorAll("a")].find((x) => /dochub\.com\/speedbotsdm\//.test(x.href || "") && !/\/new$/.test(x.href));
  return a ? a.href : "";
});
console.log("doc:", docUrl);
await page.goto(docUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
await page.waitForTimeout(10000);
await page.evaluate(() => {
  const skip = [...document.querySelectorAll("button, [role='button']")].find((e) => /^Skip$/i.test((e.textContent || "").trim()) && e.getBoundingClientRect().width > 0);
  if (skip) skip.click();
}).catch(() => {});
await page.waitForTimeout(2500);
await page.evaluate(() => { const b = document.querySelector("#share-send-btn"); if (b) b.click(); }).catch(() => {});
await page.waitForTimeout(6000);

const dump = await page.evaluate(() => {
  // restrict to the visible share dialog region
  const dialogs = [...document.querySelectorAll("[role='dialog'], [class*='modal' i]")];
  const scope = dialogs.find((d) => d.getBoundingClientRect().width > 200) || document.body;
  const text = (scope.innerText || "").slice(0, 1200);
  const inputs = [...scope.querySelectorAll("input")].map((i) => ({ id: i.id, type: i.type, value: (i.value || "").slice(0, 140), placeholder: i.placeholder, readonly: i.readOnly, cls: (i.className + "").slice(0, 40) }));
  const anchors = [...scope.querySelectorAll("a")].filter((a) => (a.href || "").includes("dochub.com")).map((a) => ({ t: (a.textContent || "").trim().slice(0, 24), href: (a.href || "").slice(0, 150), cls: (a.className + "").slice(0, 40) }));
  const buttons = [...scope.querySelectorAll("button")].map((b) => ({ t: (b.textContent || "").replace(/\s+/g, " ").trim().slice(0, 30), id: b.id, cls: (b.className + "").slice(0, 40) })).filter((b) => b.t || b.id);
  const svgs = [...scope.querySelectorAll("svg")].length;
  const url = location.href;
  return { url, text, inputs, anchors, buttons, svgs };
});
console.log(JSON.stringify(dump, null, 1));
await closeBrowser(browser);
process.exit(0);