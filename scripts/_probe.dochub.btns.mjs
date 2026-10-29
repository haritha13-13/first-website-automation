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
await page.waitForTimeout(6000);

const btns = await page.evaluate(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
  const out = [];
  for (const b of document.querySelectorAll("button,a,[role=button],input[type=submit]")) {
    const t = (b.textContent || b.value || "").replace(/\s+/g, " ").trim();
    if (!/^create document$/i.test(t)) continue;
    const r = b.getBoundingClientRect();
    const chain = [];
    let p = b.parentElement;
    for (let i = 0; i < 5 && p; i++) { chain.push(p.tagName + (p.id ? "#" + p.id : "") + "." + (p.className + "").slice(0, 40)); p = p.parentElement; }
    out.push({ text: t, vis: vis(b), disabled: b.disabled || b.getAttribute("aria-disabled"), rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, chain });
  }
  // what's the modal-ish container with the import text?
  const importEl = [...document.querySelectorAll("div,section,[role=dialog]")].filter(vis).find((e) => /will be imported to your account/i.test(e.textContent || ""));
  let info = null;
  if (importEl) {
    const r = importEl.getBoundingClientRect();
    info = { cls: (importEl.className + "").slice(0, 80), id: importEl.id, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, parentCls: (importEl.parentElement?.className + "").slice(0, 80) };
  }
  return { count: out.length, btns: out, importEl: info };
});
console.log(JSON.stringify(btns, null, 1));

await context.storageState({ path: ROOT + "/data/session.json" }).catch(() => {});
await closeBrowser(browser);
process.exit(0);