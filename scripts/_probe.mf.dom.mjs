#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity } from "../src/browser/browser.js";
import { loadEnv } from "../src/common/env.js";

const ROOT = "/home/haritha_13/behance-backlink-automator";
loadEnv();

const browser = await launchBrowser();
const { page, context } = await newPage(browser, { storageState: path.join(ROOT, "data/session.json") });
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});

const errors = [];
const logs = [];
page.on("pageerror", (e) => errors.push(String(e.message || e).slice(0, 300)));
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(`${m.type()}: ${m.text().slice(0, 200)}`); });
const failed = [];
page.on("requestfailed", (r) => failed.push(`${r.url().slice(0, 120)} -> ${r.failure()?.errorText}`));

await page.goto("https://app.mediafire.com/folder/myfiles", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(15000);

const dump = await page.evaluate(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(e).display !== "none"; };
  const btns = [...document.querySelectorAll("button, a[role='button']")].filter(vis).map((b) => ({
    tag: b.tagName,
    aria: b.getAttribute("aria-label") || "",
    title: b.getAttribute("title") || "",
    text: (b.textContent || "").trim().slice(0, 40),
    cls: (b.className + "").slice(0, 50),
  })).filter((b) => b.aria || b.title || b.text);
  const files = [...document.querySelectorAll("input[type=file]")].map((i) => ({ accept: i.accept || "", cls: (i.className + "").slice(0, 40), vis: vis(i) }));
  const iframes = [...document.querySelectorAll("iframe")].map((f) => ({ src: (f.src || "").slice(0, 120), id: f.id, cls: (f.className + "").slice(0, 40), vis: vis(f) }));
  // top-level structure + any shadow hosts
  const hosts = [...document.querySelectorAll("*")].filter((e) => e.shadowRoot).map((e) => e.tagName + "#" + (e.id || "") + "." + (e.className + "").slice(0, 30));
  const allBtns = [...document.querySelectorAll("button, a[role='button'], [aria-label]")].map((b) => ({
    aria: b.getAttribute("aria-label") || "", text: (b.textContent || "").trim().slice(0, 30), vis: vis(b),
  })).filter((b) => b.aria || b.text);
  const allInputs = [...document.querySelectorAll("input")].map((i) => ({ type: i.type, aria: i.getAttribute("aria-label") || "", vis: vis(i) }));
  const visibleText = (document.body.innerText || "").replace(/\s+/g, " ").trim().slice(0, 400);
  return { url: location.href, title: document.title, buttonsCount: btns.length, buttons: btns.slice(0, 40), allBtnsCount: allBtns.length, allBtns: allBtns.slice(0, 50), allInputs: allInputs.slice(0, 20), fileInputs: files, iframes, shadowHosts: hosts, bodyLen: document.body ? document.body.innerHTML.length : 0, visibleText };
});
console.log(JSON.stringify(dump, null, 1));
console.log("--- pageerrors ---", JSON.stringify(errors, null, 1));
console.log("--- console(err/warn) ---", JSON.stringify(logs.slice(0, 20), null, 1));
console.log("--- failed requests ---", JSON.stringify(failed.slice(0, 20), null, 1));
await page.screenshot({ path: "/tmp/opencode/mf-probe.png", fullPage: false }).catch(() => {});
await closeBrowser(browser);
process.exit(0);