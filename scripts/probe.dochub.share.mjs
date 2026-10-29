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
  text: (document.body?.innerText || "").replace(/\n{2,}/g, "\n").slice(-500),
}), label).then((s) => { console.log("\n===== " + s.label + " =====\nURL: " + s.url + "\n" + s.text.slice(-300)); });

// Straight into the editor flow from /new
await page.goto("https://dochub.com/new", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
await page.waitForTimeout(5000);
await page.locator("input[type=file]").first().setInputFiles(DOC).catch(() => {});
await page.waitForTimeout(12000);
await page.evaluate(() => {
  const el = [...document.querySelectorAll("button")].find((b) => /^Create Document$/i.test((b.textContent || "").trim()));
  if (el) el.click();
}).catch(() => {});
await page.waitForTimeout(15000);
await snap("editor open");

// Click the Share/Send button
await page.click("#share-send-btn").catch((e) => console.log("share click err:", e.message.split("\n")[0]));
await page.waitForTimeout(6000);
await snap("after share click");

const ui = await page.evaluate(() => ({
  links: [...document.querySelectorAll("a")].filter((a) => /http|link/.test((a.href || "") + (a.textContent || ""))).map((a) => ({ t: (a.textContent || "").trim().slice(0, 22), href: (a.href || "").slice(0, 70) })).slice(0, 15),
  shareBtns: [...document.querySelectorAll("button, a")].map((e) => ({ t: (e.textContent || "").trim().slice(0, 24), id: e.id, role: e.getAttribute("role") })).filter((b) => /share|link|cop|public|anyone/i.test(b.t) || b.id.includes("share")).slice(0, 15),
  dialogs: [...document.querySelectorAll("[role='dialog']")].length,
  text: (document.body?.innerText || "").slice(-500),
  clipboardInputs: [...document.querySelectorAll("input")].map((i) => ({ id: i.id, value: (i.value || "").slice(0, 80), readOnly: i.readOnly })).filter((i) => i.value || /link|url/i.test(i.id)),
}));
console.log("\nSHARE UI:", JSON.stringify(ui, null, 1));
await closeBrowser(browser);
process.exit(0);