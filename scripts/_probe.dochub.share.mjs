#!/usr/bin/env node
import fs from "node:fs";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity } from "../src/browser/browser.js";
import { loadEnv } from "../src/common/env.js";
loadEnv();
const ROOT = "/home/haritha_13/behance-backlink-automator";
const DOC_URL = process.argv[2] || "https://dochub.com/speedbotsdm/Noek8bMwx7NB2XdVl7d2qm/accounting-automation-1-docx";

const browser = await launchBrowser();
const { page, context } = await newPage(browser, {
  storageState: fs.existsSync(ROOT + "/data/session.json") ? ROOT + "/data/session.json" : undefined,
});
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});

await page.goto(DOC_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(12000);
console.log("url:", page.url());

const before = await page.evaluate(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
  const shareish = [...document.querySelectorAll("button,a,[role=button],div,span")].filter(vis)
    .map((e) => ({ tag: e.tagName, id: e.id || "", text: (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 30), cls: (e.className + "").slice(0, 40) }))
    .filter((x) => /share/i.test(x.id) || /^share$/i.test(x.text) || /send/i.test(x.id))
    .slice(0, 20);
  return { hasShareSendBtn: !!document.querySelector("#share-send-btn"), shareish };
});
console.log("before:", JSON.stringify(before, null, 1));

// click the share control
await page.evaluate(() => {
  const b = document.querySelector("#share-send-btn");
  if (b) b.click();
  else {
    const el = [...document.querySelectorAll("button,a,[role=button]")].find((e) => /^share$/i.test((e.textContent || "").trim()));
    if (el) el.click();
  }
}).catch(() => {});
await page.waitForTimeout(5000);

const dlg = await page.evaluate(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
  const inputs = [...document.querySelectorAll("input")].filter(vis).map((i) => ({ id: i.id || "", type: i.type, value: (i.value || "").slice(0, 90), readonly: i.readOnly, placeholder: i.placeholder || "" }));
  const buttons = [...document.querySelectorAll("button,a,[role=button]")].filter(vis).map((b) => ({ id: b.id || "", text: (b.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40) })).filter((b) => b.text).slice(0, 40);
  const body = (document.body.innerText || "").replace(/\s+/g, " ");
  return {
    shareLinkInput: (() => { const e = document.querySelector("#shareLink"); return e ? e.value : null; })(),
    inputs, buttons,
    mentionsGetLink: /Get Shareable Link/i.test(body),
    mentionsVerify: /verification required|further verified|reCAPTCHA/i.test(body),
    bodyTail: body.slice(-400),
  };
});
console.log("\nafter share click:", JSON.stringify(dlg, null, 1));

await context.storageState({ path: ROOT + "/data/session.json" }).catch(() => {});
await closeBrowser(browser);
process.exit(0);