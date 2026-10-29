#!/usr/bin/env node
import fs from "node:fs";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity } from "../src/browser/browser.js";
import { loadEnv } from "../src/common/env.js";

loadEnv();
const ROOT = "/home/haritha_13/behance-backlink-automator";
const DOC = process.env.DOCHUB_DOC || "/mnt/c/Users/haris/Downloads/accounting-automation.docx";

const browser = await launchBrowser();
const { page, context } = await newPage(browser, {
  storageState: fs.existsSync(ROOT + "/data/session.json") ? ROOT + "/data/session.json" : undefined,
});
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});

await page.goto("https://dochub.com/new", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(6000);
console.log("url before upload:", page.url());

await page.locator("input[type=file]").first().setInputFiles(DOC).catch((e) => console.log("upload err:", e.message));
await page.waitForTimeout(4000);

// After the file is staged, DocHub expects a "Create Document" click.
const clicked = await page.evaluate(() => {
  const b = [...document.querySelectorAll("button, a")].find((x) => /^create document$/i.test((x.textContent || "").trim()));
  if (b) { b.click(); return true; }
  return false;
}).catch(() => false);
console.log("clicked Create Document:", clicked);

let found = false;
const deadline = Date.now() + 90000;
while (Date.now() < deadline) {
  await page.waitForTimeout(3000);
  const st = await page.evaluate(() => {
    const t = document.body?.innerText || "";
    return {
      url: location.href,
      editorIframe: !!document.querySelector("iframe[src*='dochub'], iframe#editor, [class*='pdf-editor']"),
      shareBtn: !!document.querySelector("#share-send-btn"),
      capHit: /creation cap|reached your (free )?plan|upgrade to create|daily limit/i.test(t),
      openButtons: [...document.querySelectorAll("button,a")].map((b) => (b.textContent || "").trim()).filter((x) => /^(open|continue|create|save|convert|edit)/i.test(x)).slice(0, 10),
    };
  });
  const onNew = /\/new$/i.test(new URL(st.url).pathname);
  console.log(`[${Math.round((deadline - Date.now()) / -1000)}s]`, JSON.stringify(st));
  if (!onNew) { found = true; break; }
  if (st.capHit) break;
}
console.log(found ? "RESULT: reached editor/viewer" : "RESULT: did not reach editor");

await context.storageState({ path: ROOT + "/data/session.json" }).catch(() => {});
await closeBrowser(browser);
process.exit(found ? 0 : 1);