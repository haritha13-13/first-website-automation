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
setTimeout(() => process.exit(2), 80000).unref();

await page.goto("https://jumpshare.com/w/aa7ffd3/personal", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(8000);

const info = await page.evaluate(() => {
  const name = "ai-automation (1).docx";
  // Find the row element that contains the name and a share token.
  const all = [...document.querySelectorAll("div, li, tr, section, article")].filter(
    (e) => (e.textContent || "").includes(name) && e.querySelectorAll("a, input, [data-item], [data-id], [data-url], [data-link]").length
  );
  const row = all.sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length)[0] || document.body;
  const tokens = [];
  for (const el of row.querySelectorAll("*")) {
    for (const attr of ["href", "data-url", "data-link", "data-id", "data-token", "data-shareurl", "data-raw_url"]) {
      const v = el.getAttribute && el.getAttribute(attr);
      if (v && /share\/[A-Za-z0-9]{10,}/.test(v)) tokens.push({ tag: el.tagName, attr, v: v.slice(0, 60) });
    }
    const m = (el.value || "").match(/share\/[A-Za-z0-9]{10,}/);
    if (m && el.tagName === "INPUT") tokens.push({ tag: el.tagName, attr: "value", v: el.value.slice(0, 60) });
  }
  // Unique tokens
  const uniq = {};
  for (const t of tokens) uniq[t.v] = t;
  return {
    rowCls: (row.className || "").slice(0, 40),
    rowHtmlBrief: row.outerHTML.slice(0, 900),
    tokens: Object.values(uniq).slice(0, 8),
  };
});
console.log(JSON.stringify(info, null, 1));
await closeBrowser(browser);
process.exit(0);