#!/usr/bin/env node
/**
 * Verify the Jumpshare backlink fix: a user-supplied .docx must be
 * re-rendered with the keyword as a REAL hyperlink to the backlink URL.
 * Runs entirely offline, then re-reads the rebuilt docx to prove the
 * <w:hyperlink w:r:id> + relationship pointing at the URL.
 *
 * Usage: node scripts/test.bodydocx.backlink.mjs /path/to/user.docx "keyword" "backlink URL" "title"
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { extractDocxXml, docxXmlToText, toUploadableDoc } from "../src/documents/bodyDocument.js";

const [srcPath, keyword, url, title] = process.argv.slice(2);
if (!srcPath) {
  console.error("usage: node scripts/test.bodydocx.backlink.mjs <user.docx> <keyword> <backlink-url> <title>");
  process.exit(2);
}
if (!fs.existsSync(srcPath)) {
  console.error("source docx not found:", srcPath);
  process.exit(1);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jdbl-"));
console.log("source :", srcPath, `(${fs.statSync(srcPath).size} bytes)`);
console.log("keyword:", keyword || "(none)");
console.log("url    :", url || "(none)");
console.log("title  :", title || "(none)");

const srcText = docxXmlToText(extractDocxXml(srcPath));
console.log("\nsource text head:", JSON.stringify(srcText.slice(0, 160)));

const rebuilt = await toUploadableDoc({ filePath: srcPath, keyword, url, title, dir });
const xml = extractDocxXml(rebuilt);
const plain = docxXmlToText(xml);

const hyperlinkTag = xml.match(/<w:hyperlink\b[^>]*>/i);
const hasHyperlink = !!hyperlinkTag && /\br:id=["'][^"']+["']/i.test(hyperlinkTag[0]);
const linkedText = (xml.match(/<w:hyperlink\b[^>]*>([\s\S]*?)<\/w:hyperlink>/i) || [])[1] || "";
const keywordInLink = linkedText.toLowerCase().includes(String(keyword).toLowerCase());
const rels = extractDocxXmlRelationships(rebuilt, xml); // resolves rId -> URL
const linkTargetOk = Object.values(rels).some((u) => u && url && u.replace(/\/$/, "") === String(url).replace(/\/$/, ""));
const keywordInDoc = plain.toLowerCase().includes(String(keyword).toLowerCase());
const sourceTextKept = plain.toLowerCase().includes(srcText.slice(0, 40).toLowerCase());

console.log("\nrebuilt :", rebuilt);
console.log("rebuilt text head:", JSON.stringify(plain.slice(0, 160)));
console.log("\n--- CHECK ---");
console.log("has w:hyperlink in document.xml  :", hasHyperlink ? "YES" : "NO");
console.log("linked anchor text               :", JSON.stringify(linkedText || ""));
console.log("keyword inside the link          :", keywordInLink ? "YES" : "NO");
console.log("hyperlink relationship -> URL     :", linkTargetOk ? "YES" : "NO", JSON.stringify(rels));
console.log("keyword present in rebuilt text   :", keywordInDoc ? "YES" : "NO");
console.log("content preserved from source     :", sourceTextKept ? "YES" : "NO");

const pass = hasHyperlink && linkTargetOk && keywordInLink && keywordInDoc && sourceTextKept;
console.log("BACKLINK EMBEDDED?                :", pass ? "YES" : "NO");
process.exit(pass ? 0 : 1);

/* Resolve the document's hyperlink relationships (word/_rels/document.xml.rels) */
function extractDocxXmlRelationships(docxPath, docXml) {
  const relsXml = relationshipsXml(docxPath);
  const out = {};
  const relRe = /<Relationship\s+Id="([^"]+)"[^>]*Target="([^"]+)"/g;
  let m;
  while ((m = relRe.exec(relsXml))) out[m[1]] = m[2];
  return out;
}
function relationshipsXml(docxPath) {
  const buf = fs.readFileSync(docxPath);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return "";
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  let pos = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString("utf8", pos + 46, pos + 46 + nameLen);
    if (name === "word/_rels/document.xml.rels") {
      const method = buf.readUInt16LE(localOffset + 8);
      const compSize = buf.readUInt32LE(localOffset + 18);
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const comp = buf.subarray(start, start + compSize);
      try {
        return (method === 0 ? comp.toString("utf8") : zlib.inflateRawSync(comp).toString("utf8")) || "";
      } catch {
        return "";
      }
    }
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return "";
}