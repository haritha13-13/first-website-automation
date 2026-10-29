import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, newPage, closeBrowser } from "../src/browser/browser.js";
import { collectInputs, collectButtons } from "../src/browser/domProbe.js";

const storageState = path.resolve("data/session.json");
const tinyPng = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "tmp-probe.png");
writeFileSync(
  tinyPng,
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
  )
);

const dump = async (page, label) => {
  const inputs = await page.evaluate(collectInputs);
  const buttons = await page.evaluate(collectButtons);
  const state = await page.evaluate(() => {
    const title = document.querySelector('input[aria-label="Give your project a title"]');
    const modals = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')];
    const fileInputs = [...document.querySelectorAll('input[type="file"]')];
    const imgs = [...document.querySelectorAll("img")]
      .filter((i) => i.src && (i.naturalWidth || i.width) > 0)
      .map((i) => i.src.slice(0, 80));
    const banner = document.body
      .querySelectorAll('[role="alert"], [class*="toast"], [class*="banner"], [class*="notice"], [class*="Toaster"]')
      .length;
    return {
      titlePresent: !!title,
      titleVisible: title ? !!(title.offsetWidth || title.offsetHeight) : false,
      modalCount: modals.length,
      modalTexts: modals.map((m) => (m.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200)),
      fileInputCount: fileInputs.length,
      imgCount: imgs.length,
      bannerCount: banner,
      url: location.href,
    };
  });
  console.log(`\n===== ${label} =====`);
  console.log("state:", JSON.stringify(state, null, 1));
  console.log("inputs:", JSON.stringify(inputs.filter((i) => i.visible || i.type === "file"), null, 1));
  const visibleButtons = buttons
    .filter((b) => b.visible && (b.text || "").trim())
    .map((b) => (b.text || "").trim())
    .filter((t, i, a) => a.indexOf(t) === i)
    .slice(0, 30);
  console.log("visibleButtonTexts:", JSON.stringify(visibleButtons));
};

const browser = await launchBrowser();
const { page } = await newPage(browser, { storageState: existsSync(storageState) ? storageState : undefined });

console.log("Loading editor…");
await page.goto("https://www.behance.net/portfolio/editor?tracking_source=upload", { waitUntil: "domcontentloaded", timeout: 90_000 });
await page.waitForTimeout(7000);
console.log("URL:", page.url());

await dump(page, "1 fresh editor");

// Click "Add an Image"
const addImage = page.locator('button[aria-label="Add an Image"]').first();
console.log("\naddImageExists:", await addImage.count());
if (await addImage.count()) {
  await addImage.click();
  await page.waitForTimeout(3000);
}
await dump(page, "2 after clicking Add an Image");

// Try to attach the file (file input directly or via chooser button)
let attached = false;
const fileInput = page.locator('input[type="file"]');
if (await fileInput.count()) {
  try {
    await fileInput.first().setInputFiles(tinyPng);
    attached = true;
    console.log("attached via input[type=file]");
  } catch (e) {
    console.log("direct setInputFiles failed:", e.message.slice(0, 120));
  }
}
if (!attached) {
  const chooserP = new Promise((res) => page.once("filechooser", res));
  const btn = page.locator('button:has-text("Choose from computer"), button:has-text("Upload from device"), button:has-text("Choose files"), button:has-text("Browse")').first();
  console.log("uploadBtnCount:", await btn.count());
  if (await btn.count()) {
    await btn.first().click({ timeout: 5000 });
    const fc = await Promise.race([chooserP, new Promise((r) => setTimeout(() => r(null), 5000))]);
    if (fc) {
      await fc.setFiles(tinyPng);
      attached = true;
      console.log("attached via filechooser intercept");
    }
  }
}
console.log("attached:", attached);
await page.waitForTimeout(9000);
await dump(page, "3 after upload attempt (9s)");
await page.waitForTimeout(6000);
await dump(page, "4 after upload attempt (15s total)");

// Click Publish
const publishBtn = page.locator('nav[aria-label="Project Editor"] > :nth-child(4) > :nth-child(2)').first();
console.log("\npublishExists:", await publishBtn.count(), "visible:", await publishBtn.isVisible().catch(() => false));
if (await publishBtn.count()) {
  await publishBtn.click();
  await page.waitForTimeout(4000);
}
await dump(page, "5 after clicking Publish");

// Retry once more
if (await publishBtn.count()) {
  await publishBtn.click().catch(() => {});
  await page.waitForTimeout(5000);
}
await dump(page, "6 after second Publish click");

await closeBrowser(browser);