import fs from "node:fs";
process.env.AUTOMATOR_HEADLESS = "1";
import os from "node:os";
import path from "node:path";
import { launchBrowser, newPage, closeBrowser } from "../src/browser/browser.js";
import { executeWorkflow } from "../src/workflow/engine.js";

function encodeHTML(html) {
  return Buffer.from(html).toString("base64");
}

const html = fs.readFileSync(new URL("./fixtures/form.html", import.meta.url), "utf8");
const dataUrl = `data:text/html;base64,${encodeHTML(html)}`;
const tmpImg = path.join(os.tmpdir(), `smoke-upload-${Date.now()}.png`);
fs.writeFileSync(tmpImg, "fake image bytes");

const workflow = {
  meta: { siteName: "TestForm", siteUrl: "https://example.com", siteKey: "example-com" },
  auth: { required: false, loginSteps: [] },
  fieldMappings: {
    title: "fill-title",
    description: "fill-description",
    category: "select-category",
    tags: "fill-tags",
    image: "upload-cover",
    backlinkUrl: "append-backlink",
  },
  steps: [
    { id: "goto-form", action: "goto", url: dataUrl },
    { id: "fill-title", action: "fill", selector: "#title", property: "title" },
    { id: "fill-description", action: "fill", selector: "#desc", property: "description" },
    { id: "select-category", action: "select", selector: "#cat", property: "category" },
    { id: "fill-tags", action: "fill", selector: "#tags", property: "tags" },
    { id: "upload-cover", action: "upload", selector: "input[type=file]", property: "image" },
    { id: "click-link", action: "click", selector: "#link" },
    { id: "append-backlink", action: "type", property: "backlinkUrl", prefixNewline: true },
    { id: "submit-post", action: "click", selector: "#publish" },
  ],
};

const input = {
  title: "My test blog title",
  description: "Body content here.\nSecond line.",
  category: "Travel",
  tags: ["seo", "travel"],
  visibility: "public",
  imagePath: tmpImg,
  backlinkUrl: "https://mybacklink.example",
  credentials: null,
};

const browser = await launchBrowser();
const { page } = await newPage(browser);
const result = await executeWorkflow({ workflow, input, page });

console.log("\n--- step results ---");
let allOk = true;
for (const r of result.results) {
  const flag = r.ok ? "ok " : "FAIL";
  if (!r.ok && !r.skipped) allOk = false;
  console.log(` [${flag}] ${r.stepId.padEnd(20)} ${r.action}`);
}
console.log(`\nfailures: ${result.failures.length}`);
console.log(`publishedUrl: ${result.publishedUrl}`);

const posted = await page.evaluate(() => window.__posted && Object.fromEntries([...window.__posted.entries()]));
console.log("\n--- form values captured by page ---");
console.log(JSON.stringify(posted, null, 2));

await closeBrowser(browser);
fs.unlinkSync(tmpImg);

if (!allOk) process.exit(1);
console.log("\nENGINE SMOKE TEST PASSED");