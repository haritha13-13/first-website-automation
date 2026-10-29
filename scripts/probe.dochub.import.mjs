#!/usr/bin/env node
import fs from "node:fs";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity, persistSession } from "/home/haritha_13/behance-backlink-automator/src/browser/browser.js";
import { loadEnv } from "/home/haritha_13/behance-backlink-automator/src/common/env.js";
loadEnv();
const ROOT = "/home/haritha_13/behance-backlink-automator";
const DOC = "/mnt/c/Users/haris/Downloads/ai-automation (1).docx";
const browser = await launchBrowser();
const { page, context } = await newPage(browser, {
  storageState: fs.existsSync(ROOT + "/data/session.json") ? ROOT + "/data/session.json" : undefined,
});
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});
page.on("framenavigated", (f) => { if (f === page.mainFrame()) console.log("   NAV ->", f.url()); });
const snap = (label) => page.evaluate((label) => ({
  label, url: location.href,
  text: (document.body?.innerText || "").replace(/\n{2,}/g, "\n").slice(0, 320),
  inputs: [...document.querySelectorAll("input[type=file]")].map((i) => i.id),
}), label).then((s) => { console.log("\n===== " + s.label + " =====\nURL: " + s.url + "\n" + s.text.slice(0, 180)); console.log("   file inputs:", JSON.stringify(s.inputs)); });

await page.goto("https://dochub.com/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
await page.waitForTimeout(6000);
await snap("dashboard");

// Set up a file chooser handler
const chooserPromise = page.waitForEvent("filechooser", { timeout: 15000 }).catch(() => null);

// Click "Import a Document"
const hit = await page.evaluate(() => {
  const targets = [...document.querySelectorAll("a, button, div, span, li, [role='menuitem']")];
  const el = targets.find((e) => /^Import a Document$/i.test((e.textContent || "").trim()) && e.getBoundingClientRect().width > 0 && e.children.length <= 3);
  if (!el) return { hit: false };
  el.click();
  return { hit: true, tag: el.tagName, outer: el.outerHTML.slice(0, 140) };
});
console.log("\nclick Import a Document:", JSON.stringify(hit));

const chooser = await chooserPromise;
if (chooser) {
  console.log("   filechooser captured:", chooser.element().id);
  await chooser.setFiles(DOC);
  console.log("   file set:", DOC);
} else {
  console.log("   no filechooser within 15s");
}
await page.waitForTimeout(10000);
await snap("after import/upload");

const ui = await page.evaluate(() => ({
  text: (document.body?.innerText || "").slice(0, 400),
  btns: [...document.querySelectorAll("button, a[role='button']")].map((e) => ({ t: (e.textContent || "").trim().slice(0, 24), id: e.id })).filter((b) => b.t).slice(0, 18),
  shareBtns: [...document.querySelectorAll("button, a")].map((e) => ({ t: (e.textContent || "").trim().slice(0, 24), href: (e.href || "").slice(0, 45) })).filter((b) => /share|link/i.test(b.t + b.href)).slice(0, 10),
}));
console.log("\nUI:", JSON.stringify(ui, null, 1));
await persistSession(context, { email: "speedbotsdm@gmail.com", siteName: "dochub" }).catch(() => {});
await closeBrowser(browser);
process.exit(0);