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
context.on("page", (p) => console.log("!! new page/tab opened:", p.url()));

await page.goto(DOC_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(10000);

// open share
await page.evaluate(() => { const b = document.querySelector("#share-send-btn"); if (b) b.click(); }).catch(() => {});
await page.waitForTimeout(4000);

const before = await page.evaluate(() => {
  const vis = (e) => e.getBoundingClientRect().width > 0;
  return {
    getLinkCands: [...document.querySelectorAll("button,[role=button],a,div,span")]
      .filter((e) => vis(e) && /^get shareable link\b/i.test((e.textContent || "").replace(/\s+/g, " ").trim()))
      .map((e) => ({ tag: e.tagName, cls: (e.className + "").slice(0, 40), text: (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60) })),
  };
});
console.log("getLink candidates:", JSON.stringify(before, null, 1));

const clicked = await page.evaluate(() => {
  const vis = (e) => e.getBoundingClientRect().width > 0;
  const cands = [...document.querySelectorAll("button,[role=button],a,div,span")]
    .filter((e) => vis(e) && /^get shareable link\b/i.test((e.textContent || "").replace(/\s+/g, " ").trim()));
  if (!cands.length) return false;
  cands.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
  const el = cands[0];
  (el.closest("button,[role='button'],a,[tabindex]") || el).click();
  return true;
}).catch(() => false);
console.log("clicked Get Shareable Link:", clicked);

for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(3000);
  const st = await page.evaluate(() => {
    const vis = (e) => e.getBoundingClientRect().width > 0;
    const inputs = [...document.querySelectorAll("input")].filter(vis).map((x) => ({ id: x.id || "", type: x.type, ro: x.readOnly, val: (x.value || "").slice(0, 90) })).filter((x) => x.id || x.ro || /dochub\.com\/m\//.test(x.val));
    const body = (document.body.innerText || "").replace(/\s+/g, " ");
    return {
      shareLink: (() => { const e = document.querySelector("#shareLink"); return e ? e.value : null; })(),
      inputs,
      verify: /verification required|further verified|reCAPTCHA|confirm your email/i.test(body),
      tail: body.slice(-250),
    };
  });
  console.log(`\n[+${(i + 1) * 3}s]`, JSON.stringify(st));
  if (st.shareLink && /dochub\.com\/m\//.test(st.shareLink)) { console.log("GOT LINK"); break; }
}

await context.storageState({ path: ROOT + "/data/session.json" }).catch(() => {});
await closeBrowser(browser);
process.exit(0);