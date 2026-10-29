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

const log = (...a) => console.log(...a);

log("goto https://app.dochub.com/myaccount/ ...");
await page.goto("https://app.dochub.com/myaccount/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => log("goto err", e.message));
await page.waitForTimeout(7000);
log("url:", page.url());

const state = await page.evaluate(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(e).display !== "none"; };
  const btns = [...document.querySelectorAll("button, a")].filter(vis).map((b) => (b.textContent || "").trim().slice(0, 30)).filter(Boolean);
  const files = [...document.querySelectorAll("input[type=file]")].map((i) => ({ accept: i.accept || "", vis: vis(i) }));
  return { url: location.href, title: document.title, buttons: [...new Set(btns)].slice(0, 40), fileInputs: files, text: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 300) };
});
log(JSON.stringify(state, null, 1));

log("\ngoto https://dochub.com/new ...");
await page.goto("https://dochub.com/new", { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => log("goto err", e.message));
await page.waitForTimeout(7000);
log("url:", page.url());
const state2 = await page.evaluate(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(e).display !== "none"; };
  const btns = [...document.querySelectorAll("button, a")].filter(vis).map((b) => (b.textContent || "").trim().slice(0, 30)).filter(Boolean);
  const files = [...document.querySelectorAll("input[type=file]")].map((i) => ({ accept: i.accept || "", vis: vis(i) }));
  return { url: location.href, title: document.title, buttons: [...new Set(btns)].slice(0, 40), fileInputs: files, text: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 300) };
});
log(JSON.stringify(state2, null, 1));

await closeBrowser(browser);
process.exit(0);