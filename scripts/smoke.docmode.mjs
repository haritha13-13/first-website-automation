import { launchBrowser, newPage, closeBrowser } from "../src/browser/browser.js";
process.env.AUTOMATOR_HEADLESS = "1";
import { executeWorkflow } from "../src/workflow/engine.js";
import { contentModeFromWorkflow } from "../src/input/collector.js";
import { generateBodyDocuments } from "../src/documents/bodyDocument.js";
import JSZip from "jszip";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

// 1. contentModeFromWorkflow derives "document" from a bodyDocument step only.
const docWorkflow = {
  meta: { siteName: "DocSite", siteUrl: "https://doc.test", siteKey: "doc-test" },
  steps: [{ id: "upload-body-document", action: "upload", property: "bodyDocument" }],
};
const textWorkflow = {
  meta: { siteName: "TextSite", siteUrl: "https://text.test", siteKey: "text-test" },
  steps: [{ id: "fill-description", action: "fill", property: "description" }],
};
const explicitText = { meta: {}, inputs: { content: { mode: "text" } }, steps: [] };
const explicitDoc = { meta: {}, inputs: { content: { mode: "document" } }, steps: [] };
let pass = true;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) pass = false;
  console.log(` [${ok ? "ok" : "FAIL"}] ${name}: ${got} (want ${want})`);
};
check("bodyDocument step -> document", contentModeFromWorkflow(docWorkflow), "document");
check("description step -> text", contentModeFromWorkflow(textWorkflow), "text");
check("inputs.content.mode=text wins", contentModeFromWorkflow(explicitText), "text");
check("inputs.content.mode=document wins", contentModeFromWorkflow(explicitDoc), "document");
check("empty workflow -> text", contentModeFromWorkflow({ steps: [] }), "text");

// 2. Document URL download/upload end-to-end via the engine.
const html = `<!doctype html><html><body>
  <button id="open-dialog">Publish</button>
  <section id="dialog" hidden>
    <input id="t" aria-label="Give your project a title" />
    <input id="doc" type="file" accept=".docx,.txt" aria-label="Blog attachment (document)" />
  </section>
  <script>
    document.getElementById("open-dialog").onclick = () => {
      document.getElementById("dialog").hidden = false;
    };
  </script>
</body></html>`;
const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

// Serve a .txt document over HTTP so the tool retrieves it from a URL.
const docText = "This is the blog body speedbots retrieved from the URL.";
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain", "Content-Disposition": 'attachment; filename="blog.txt"' });
  res.end(docText);
});
await new Promise((r) => server.listen(0, r));

const workflow = {
  meta: { siteName: "DocSite", siteUrl: "https://doc.test", siteKey: "doc-test" },
  auth: { required: false, loginSteps: [] },
  inputs: { content: { mode: "document" } },
  fieldMappings: { title: "fill-title", description: "upload-body-document" },
  steps: [
    { id: "goto", action: "goto", url: dataUrl },
    { id: "open-dialog", action: "click", selector: "#open-dialog", text: "Publish", waitAfter: 300 },
    { id: "fill-title", action: "fill", selector: "#t", property: "title" },
    { id: "upload-body-document", action: "upload", selector: "#doc", property: "bodyDocument", waitAfter: 1200 },
  ],
};
const input = {
  title: "Doc body title",
  description: "", // not used — the document URL drives the body
  bodyDocumentUrl: `http://127.0.0.1:${server.address().port}/blog.txt`,
  tags: [],
  keyword: "",
  credentials: null,
};

const browser = await launchBrowser();
const { page } = await newPage(browser);
const result = await executeWorkflow({ workflow, input, page });
for (const s of result.results) {
  if (!s.ok && !s.skipped) pass = false;
  console.log(` [${s.ok ? "ok" : "FAIL"}] ${s.stepId} ${s.action}${s.error ? " -> " + s.error : ""}`);
}
const fname = await page.evaluate(() => document.getElementById("doc").files[0]?.name || "(none)");
const docxValid = input.bodyDocumentPath
  ? path.extname(input.bodyDocumentPath) === ".docx" &&
    fs.readFileSync(input.bodyDocumentPath).includes(Buffer.from("word/document.xml"))
  : false;
console.log("uploaded file:", fname);
if (!/\.docx$/.test(fname)) { pass = false; console.log("FAIL: downloaded doc not uploaded"); }
if (!docxValid) { pass = false; console.log("FAIL: downloaded/txt not converted into a valid docx"); }
console.log("downloaded to:", input.bodyDocumentPath);

// 3. generateBodyDocuments still yields a .docx with keyword hyperlink.
const docs = await generateBodyDocuments({ text: "Doc text speedbots here.", keyword: "speedbots", url: "https://speedbots.io/x", title: "gen" });
console.log("generated docx:", fs.existsSync(docs.docxPath), docs.docxPath);

// 3b. A multi-word keyword must hyperlink only its FIRST word: the anchor text
// in the .docx must be exactly one word, with the rest of the phrase outside.
const multi = await generateBodyDocuments({ text: "Doc text speedbots platform here.", keyword: "speedbots platform", url: "https://speedbots.io/x", title: "gen" });
let hyper = { singleAnchor: false, fullPhraseKept: false };
try {
  const zip = await JSZip.loadAsync(await fs.promises.readFile(multi.docxPath));
  const xml = await zip.file("word/document.xml").async("string");
  const blocks = xml.match(/<w:hyperlink[\s\S]*?<\/w:hyperlink>/g) || [];
  const texts = blocks.map((b) =>
    (b.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, "")).join("")
  );
  const bodyText = (xml.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, "")).join("");
  hyper = {
    singleAnchor: texts.length === 1 && texts[0] === "speedbots" && !/\s/.test(texts[0]),
    fullPhraseKept: bodyText.includes("speedbots platform here."),
  };
} catch (e) {
  console.log("hyperlink check error:", e.message);
}
console.log("multi-word keyword -> hyperlink covers only first word:", hyper.singleAnchor, "| full phrase kept:", hyper.fullPhraseKept);
pass = pass && hyper.singleAnchor && hyper.fullPhraseKept;

await server.close();
await closeBrowser(browser);
console.log(pass ? "\nDOC-MODE TEST PASSED" : "\nDOC-MODE TEST FAILED");
process.exit(pass ? 0 : 1);