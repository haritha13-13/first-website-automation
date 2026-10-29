#!/usr/bin/env node
import fs from "node:fs";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity, persistSession } from "/home/haritha_13/behance-backlink-automator/src/browser/browser.js";
import { loadEnv } from "/home/haritha_13/behance-backlink-automator/src/common/env.js";
loadEnv();
const ROOT = "/home/haritha_13/behance-backlink-automator";
const browser = await launchBrowser();
const { page, context } = await newPage(browser, {
  storageState: fs.existsSync(ROOT + "/data/session.json") ? ROOT + "/data/session.json" : undefined,
});
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});
const snap = (label) => page.evaluate((label) => ({
  label, url: location.href,
  text: (document.body?.innerText || "").replace(/\n{2,}/g, "\n").slice(0, 400),
}), label).then((s) => console.log("\n===== " + s.label + " =====\nURL: " + s.url + "\n" + s.text));

await page.goto("https://www.dochub.com/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
await page.waitForTimeout(5000);
await snap("home (logged in?)");

// Click "New Document" nav item
const clickedNew = await page.evaluate(() => {
  const el = [...document.querySelectorAll("a, button, [role='menuitem'], [role='button']")].find((e) => {
    const t = (e.textContent || "").trim();
    return /^New Document$/i.test(t) || /^New$/.test(t);
  });
  if (el) { el.click(); return { ok: true, tag: el.tagName, text: (el.textContent || "").trim().slice(0, 20) }; }
  return { ok: false };
});
console.log("\nclick New Document:", JSON.stringify(clickedNew));
await page.waitForTimeout(5000);
await snap("after New Document click");

// dump all buttons + links + inputs now
const ui = await page.evaluate(() => ({
  btns: [...document.querySelectorAll("button")].map((e) => ({ t: (e.textContent || "").trim().slice(0, 24), id: e.id, title: e.title })).filter((b) => b.t).slice(0, 25),
  links: [...document.querySelectorAll("a")].map((a) => ({ t: (a.textContent || "").trim().slice(0, 20), href: (a.href || "").slice(0, 55) })).filter((a) => a.t).slice(0, 20),
  inputs: [...document.querySelectorAll("input")].map((i) => ({ id: i.id, type: i.type, accept: i.accept || "" })).slice(0, 10),
}));
console.log("\nUI:", JSON.stringify(ui, null, 1));
await persistSession(context, { email: "speedbotsdm@gmail.com", siteName: "dochub" }).catch(() => {});
await closeBrowser(browser);
process.exit(0);