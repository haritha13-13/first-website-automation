#!/usr/bin/env node
import fs from "node:fs";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity } from "../src/browser/browser.js";
import { loadEnv } from "../src/common/env.js";
loadEnv();
const ROOT = "/home/haritha_13/behance-backlink-automator";
const DOC = process.env.DOCHUB_DOC || "/mnt/c/Users/haris/Downloads/accounting-automation (1).docx";

const browser = await launchBrowser();
const { page, context } = await newPage(browser, {
  storageState: fs.existsSync(ROOT + "/data/session.json") ? ROOT + "/data/session.json" : undefined,
});
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});

await page.goto("https://dochub.com/new", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(8000);
await page.locator("input[type=file]").first().setInputFiles(DOC).catch((e) => console.log("upload err:", e.message));
await page.waitForTimeout(5000);

const dialog = await page.evaluate(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
  // find the container that mentions the import sentence
  const anchor = [...document.querySelectorAll("div,section,form,[role=dialog]")]
    .filter(vis)
    .find((e) => /will be imported to your account/i.test(e.textContent || ""));
  let dialog = anchor;
  for (let i = 0; i < 8 && dialog && dialog.parentElement; i++) {
    if (/dialog|modal|popup|overlay/i.test(dialog.className + "") || dialog.getAttribute("role") === "dialog") break;
    dialog = dialog.parentElement;
  }
  dialog = dialog || anchor;
  const btns = dialog ? [...dialog.querySelectorAll("button,a,[role=button],input[type=submit]")].filter(vis).map((b, i) => ({
    i, tag: b.tagName, text: (b.textContent || b.value || "").replace(/\s+/g, " ").trim().slice(0, 40),
    id: b.id || "", cls: (b.className + "").slice(0, 50), disabled: b.disabled || b.getAttribute("aria-disabled"),
  })) : [];
  return {
    foundAnchor: !!anchor,
    dialogTag: dialog ? dialog.tagName : null,
    dialogId: dialog ? dialog.id : "",
    dialogCls: dialog ? (dialog.className + "").slice(0, 80) : "",
    dialogText: dialog ? (dialog.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200) : "",
    buttons: btns,
  };
});
console.log(JSON.stringify(dialog, null, 1));

// Click the Create Document button INSIDE the import dialog (not the dashboard one).
const result = await page.evaluate(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
  const anchor = [...document.querySelectorAll("div,section,form,[role=dialog]")].filter(vis).find((e) => /will be imported to your account/i.test(e.textContent || ""));
  if (!anchor) return { clicked: false, reason: "no anchor" };
  let root = anchor;
  for (let i = 0; i < 8 && root && root.parentElement; i++) {
    if (/dialog|modal|popup|overlay/i.test(root.className + "") || root.getAttribute("role") === "dialog") break;
    root = root.parentElement;
  }
  root = root || anchor;
  const btn = [...root.querySelectorAll("button,a,[role=button]")].filter(vis).find((b) => /^create document$/i.test((b.textContent || "").trim()));
  if (!btn) return { clicked: false, reason: "no button in dialog" };
  btn.click();
  return { clicked: true, text: (btn.textContent || "").trim() };
});
console.log("click dialog Create Document:", JSON.stringify(result));

for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(3000);
  const st = await page.evaluate(() => ({
    url: location.href,
    shareBtn: !!document.querySelector("#share-send-btn"),
    importing: /importing|processing|please wait|preparing/i.test(document.body?.innerText || ""),
    capHit: /creation cap|reached your (free )?plan|upgrade to create|daily limit/i.test(document.body?.innerText || ""),
  }));
  console.log(`[+${(i + 1) * 3}s]`, JSON.stringify(st));
  if (st.shareBtn || (!/\/new$/i.test(new URL(st.url).pathname) && st.url !== "https://dochub.com/new")) break;
  if (st.capHit) { console.log("CAP HIT"); break; }
}

await context.storageState({ path: ROOT + "/data/session.json" }).catch(() => {});
await closeBrowser(browser);
process.exit(0);