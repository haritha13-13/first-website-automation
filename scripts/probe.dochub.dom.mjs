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
await page.goto("https://dochub.com/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
await page.waitForTimeout(6000);

const info = await page.evaluate(() => {
  const find = (re) => {
    const els = [...document.querySelectorAll("a, button, span, div, li, [role='menuitem']")].filter((e) => re.test((e.textContent || "").trim()) && e.getBoundingClientRect().width > 0 && e.children.length <= 4);
    return els.slice(0, 4).map((e) => ({
      tag: e.tagName, id: e.id, cls: (e.className + "").split(" ").slice(0, 3).join(" "),
      href: e.href || "", role: e.getAttribute("role"),
      rect: `${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}@${Math.round(e.getBoundingClientRect().x)},${Math.round(e.getBoundingClientRect().y)}`,
      text: (e.textContent || "").trim().slice(0, 25),
      outer: e.outerHTML.slice(0, 180),
    }));
  };
  return {
    newDoc: find(/^New Document$/i),
    dashboard: find(/^Dashboard$/i),
    allNav: [...document.querySelectorAll("nav a, [class*='sidebar'] a, aside a")].map((a) => ({ t: (a.textContent || "").trim().slice(0, 22), href: a.href, cls: (a.className + "").slice(0, 24) })).slice(0, 20),
  };
});
console.log(JSON.stringify(info.newDoc, null, 1));
console.log("--- dashboard ---");
console.log(JSON.stringify(info.dashboard, null, 1));
console.log("--- sidebar nav ---");
console.log(JSON.stringify(info.allNav, null, 1));
await closeBrowser(browser);
process.exit(0);