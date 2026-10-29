import { launchBrowser, newPage, closeBrowser } from "../src/browser/browser.js";
process.env.AUTOMATOR_HEADLESS = "1";
import { executeWorkflow } from "../src/workflow/engine.js";

// Mirrors the Behance publish flow: a contenteditable Body block plus a dialog
// holding Title, meta Description, and Tags. All *recorded* selectors below are
// per-session UUIDs that no longer exist, so every fill must self-heal via
// salvageFill — and the meta description must land in the dialog textarea, NOT
// the contenteditable body that appears first in the DOM.
const html = `<!doctype html><html><body>
  <div contenteditable="true" id="body-editor">original body text</div>
  <button id="open-dialog">Publish</button>
  <section id="dialog" hidden>
    <input id="t" aria-label="Give your project a title" />
    <textarea id="project-description" aria-label="Description"></textarea>
    <input id="tags" placeholder="Add up to 10 keywords to help people discover your project" />
  </section>
  <script>
    document.getElementById("open-dialog").onclick = () => {
      document.getElementById("dialog").hidden = false;
      window.__dialogOpened = true;
    };
  </script>
</body></html>`;

const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

const workflow = {
  meta: { siteName: "StaleTest", siteUrl: "https://x.test", siteKey: "x-test" },
  auth: { required: false, loginSteps: [] },
  fieldMappings: { title: "fill-title", description: "fill-description", tags: "fill-tags" },
  steps: [
    { id: "goto", action: "goto", url: dataUrl },
    { id: "open-dialog", action: "click", selector: "#open-dialog", text: "Publish", waitAfter: 300 },
    // Stale per-session UUID selectors — must be re-probed by salvageFill.
    { id: "fill-title", action: "fill", selector: "#\\31 1111111-aaaa-44c8-b645-530849dbd197", property: "title" },
    { id: "fill-description", action: "fill", selector: "#\\32 2222222-bbbb-44c8-b645-530849dbd197", property: "description" },
    { id: "fill-modal-description", action: "fill", selector: "#\\33 3333333-cccc-44c8-b645-530849dbd197", property: "shortDescription" },
    { id: "fill-tags", action: "fill", selector: "#\\34 4444444-dddd-44c8-b645-530849dbd197", property: "tags" },
  ],
};

const input = {
  title: "Stale title",
  description: "Stale body",
  shortDescription: "Stale short blurb",
  tags: ["a", "b"],
  credentials: null,
};

const browser = await launchBrowser();
const { page } = await newPage(browser);
const result = await executeWorkflow({ workflow, input, page });

const titleVal = await page.evaluate(() => document.getElementById("t").value);
const descVal = await page.evaluate(() => document.getElementById("project-description").value);
const tagsVal = await page.evaluate(() => document.getElementById("tags").value);
const bodyVal = await page.evaluate(() => document.getElementById("body-editor").innerText);

console.log("\n--- step results ---");
let pass = true;
for (const r of result.results) {
  const flag = r.ok ? "ok " : "FAIL";
  console.log(` [${flag}] ${String(r.stepId).padEnd(22)} ${r.action}${r.salvaged ? " (salvaged)" : ""}`);
  if (!r.ok && !r.skipped) { pass = false; console.log("      error:", r.error); }
}
console.log(`title value: "${titleVal}"`);
console.log(`dialog description value: "${descVal}"`);
console.log(`tags value: "${tagsVal}"`);
console.log(`body editor untouched: "${bodyVal}"`);

if (titleVal !== "Stale title") { pass = false; console.log("FAIL: title not filled via salvage"); }
if (descVal !== "Stale short blurb") { pass = false; console.log("FAIL: dialog description not filled via salvage"); }
if (tagsVal !== "a, b") { pass = false; console.log("FAIL: tags not filled via salvage"); }
if (bodyVal.trim() !== "original body text") { pass = false; console.log("FAIL: salvage hijacked the contenteditable body"); }
if (result.failures.length) pass = false;

const salvagedCount = result.results.filter((r) => r.salvaged).length;
console.log(`\nsalvaged step count: ${salvagedCount} (expected 4)`);
if (salvagedCount !== 4) pass = false;

await closeBrowser(browser);
if (!pass) process.exit(1);
console.log("\nSALVAGE SMOKE TEST PASSED");