import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Document, Packer, Paragraph, TextRun, ExternalHyperlink } from "docx";
import { config } from "../config.js";

/**
 * Some directory sites won't accept a pasted body — they require the blog
 * content as an uploaded document (the publish dialog exposes a file input
 * instead of a contenteditable/textarea). This module renders the same body
 * text into a .docx (with the anchor keyword turned into a clickable
 * backlink hyperlink) plus a plain .txt fallback, so the engine can upload
 * the body just like it uploads the cover image.
 */

export function defaultDocDir() {
  return path.join(config.root, "var", "documents");
}

export function fileNameSafe(s) {
  return String(s || "post")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "post";
}

/**
 * Render an OOXML hyperlink for the keyword. `text` is a run of plain text
 * that MUST contain the keyword (case-insensitively); only the FIRST WORD of
 * the keyword occurrence is wrapped in an ExternalHyperlink (the rest of the
 * phrase stays as plain text) so the published document carries a real
 * backlink on a single anchor word.
 */
function runsWithLink(text, keyword, url, alreadyLinked) {
  const anchorWord = (kw) => {
    if (!kw) return "";
    return kw.trim().split(/\s+/)[0] || "";
  };
  const word = anchorWord(keyword);
  if (alreadyLinked || !word) return { runs: [new TextRun(text)], didLink: false };
  const kwIdx = text.toLowerCase().indexOf(String(keyword).toLowerCase());
  if (kwIdx < 0) return { runs: [new TextRun(text)], didLink: false };
  const slice = text.slice(kwIdx);
  const m = slice.match(/^\s*(\S+)/);
  const anchor = m ? m[1] : word;
  const before = text.slice(0, kwIdx);
  const after = text.slice(kwIdx + anchor.length);
  const runs = [];
  if (before) runs.push(new TextRun(before));
  runs.push(
    new ExternalHyperlink({
      children: [new TextRun({ text: anchor, style: "Hyperlink" })],
      link: url,
    })
  );
  if (after) runs.push(new TextRun(after));
  return { runs, didLink: true };
}

/**
 * Build a .docx in memory from the blog body text. The keyword (when given)
 * becomes a real hyperlink inside the document.
 */
export async function buildDocxBuffer({ text, keyword, url, title = "" }) {
  const body = String(text || "").replace(/\r\n/g, "\n");
  let linked = false;
  const paras = body.split("\n").map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return new Paragraph({ children: [new TextRun("")] });
    const out = runsWithLink(trimmed, keyword, url, linked);
    if (out.didLink) linked = true; // only ONE anchor word across the whole doc
    return new Paragraph({ children: out.runs });
  });
  const doc = new Document({
    creator: "behance-backlink-automator",
    title: title || "Blog post",
    defaultRun: { size: 24, font: "Calibri" },
    styles: {
      default: {
        document: {
          run: { size: 24, font: "Calibri" },
        },
      },
      paragraphStyles: [
        {
          id: "Hyperlink",
          name: "Hyperlink",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: {
            color: "0563C1",
            underline: {},
          },
        },
      ],
    },
    sections: [
      {
        properties: {},
        children: paras,
      },
    ],
  });
  return Packer.toBuffer(doc);
}

/**
 * Generate both the .docx and the .txt for a body, writing them into
 * `<var>/documents`. Returns the file paths (docx first, then txt).
 */
export async function generateBodyDocuments({ text, keyword, url, title = "", dir = defaultDocDir() }) {
  fs.mkdirSync(dir, { recursive: true });
  const base = `${fileNameSafe(title || "post")}-${Date.now()}`;
  const docxPath = path.join(dir, `${base}.docx`);
  const txtPath = path.join(dir, `${base}.txt`);

  const docx = await buildDocxBuffer({ text, keyword, url, title });
  fs.writeFileSync(docxPath, docx);
  fs.writeFileSync(txtPath, String(text || ""), "utf8");

  return { docxPath, txtPath, docx, txt: String(text || "") };
}

/**
 * Convert a Windows-style path (drive letter or UNC) a WSL user pasted into
 * the equivalent path in this Linux environment, so a path like
 * C:\Users\haris\Downloads\foo.docx becomes /mnt/c/Users/haris/Downloads/foo.docx.
 * Returns the input unchanged when it isn't a Windows path.
 */
export function toWslPath(p) {
  if (!p) return p;
  const s = String(p).trim();
  if (/^[a-zA-Z]:[\\/]/.test(s)) {
    const drive = s[0].toLowerCase();
    const rest = s.slice(2).replace(/^[\\/]+/, "").replace(/\\/g, "/");
    return `/mnt/${drive}/${rest}`;
  }
  if (s.startsWith("\\\\")) {
    /* UNC share \\server\share is not mounted under WSL — bail out loudly. */
    throw new Error(`Unsupported UNC network path: "${p}". Copy the file into your WSL home or /mnt/c first.`);
  }
  return s;
}

/**
 * Fetch the user-provided Document URL (or accept a local file path) and save
 * it locally so the engine can upload it. Local paths that already exist on
 * disk are used directly (no network involved). For URLs, the extension is
 * taken from the URL path; falls back to the Content-Type header, then
 * `.docx`. Returns the saved file path.
 */
export async function downloadDocumentUrl(url, { title = "", dir = defaultDocDir() } = {}) {
  const raw = String(url || "").trim();
  if (raw && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    const local = toWslPath(raw);
    if (fs.existsSync(local)) return local;
    throw new Error(`Document file not found at local path: ${local} (tried: "${raw}")`);
  }
  const res = await fetch(raw, {
    headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36" },
  });
  if (!res.ok) throw new Error(`Document download failed (HTTP ${res.status}) for ${raw}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  const parsed = new URL(raw);
  let ext = path.extname(parsed.pathname.split("/").pop()).toLowerCase();
  if (!ext || !/^\.[a-z0-9]+$/i.test(ext)) {
    const mime = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    ext = { "application/pdf": ".pdf", "application/msword": ".doc", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx", "text/plain": ".txt", "application/rtf": ".rtf" }[mime] || ".docx";
  }

  fs.mkdirSync(dir, { recursive: true });
  const base = `${fileNameSafe(title || "post")}-${Date.now()}`;
  const filePath = path.join(dir, `${base}${ext}`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

/** True when a URL looks like a document (file-ish extension or doc MIME path). */
export function isDocumentUrl(url) {
  const u = String(url || "").trim();
  if (!u) return false;
  try {
    const ext = path.extname(new URL(u).pathname).toLowerCase();
    return [".doc", ".docx", ".txt", ".pdf", ".rtf", ".odt", ".md", ".text"].includes(ext);
  } catch {
    return false;
  }
}

/**
 * Extract the raw OOXML of `word/document.xml` out of a .docx (which is a
 * ZIP archive) without pulling in a dependency. Reads the central directory to
 * locate the entry, then inflates its (usually DEFLATE) bytes with the
 * built-in zlib. Returns "" on any corruption so callers can fall back to
 * uploading the original file.
 */
export function extractDocxXml(filePath) {
  const buf = fs.readFileSync(filePath);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); // PK\x05\x06
  if (eocd < 0) return "";
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  let pos = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break; // central dir header PK\x01\x02
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString("utf8", pos + 46, pos + 46 + nameLen);
    if (name === "word/document.xml") {
      const method = buf.readUInt16LE(localOffset + 8);
      const compSize = buf.readUInt32LE(localOffset + 18);
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const comp = buf.subarray(start, start + compSize);
      try {
        return method === 0 ? comp.toString("utf8") : zlib.inflateRawSync(comp).toString("utf8");
      } catch {
        return "";
      }
    }
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return "";
}

/**
 * Flatten `word/document.xml` into plain text: paragraph breaks become
 * newlines, runs/tags are stripped, and XML entities are unescaped.
 */
export function docxXmlToText(xml) {
  if (!xml) return "";
  return String(xml)
    .replace(/<w:tab[^>]*\/>/g, " ")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/g, "");
}

/** Paths this process has already re-rendered, so a rebuilt docx is never
 * re-processed (would only change its filename again on the second call). */
const RENDERED_DOCX_PATHS = new Set();

/**
 * Directory-style platforms (sharepresentation, slideshare, jumpshare, etc.)
 * only accept presentation/document formats — .pdf, .docx, .ppt(x), .ppsx,
 * .potx — and the automator's "backlink" lives INSIDE the uploaded document
 * (the keyword wrapped in a hyperlink). A .txt (or any unsupported text
 * document) comes from the collector as-is and the site rejects it with "file
 * format is not supported", so it is re-rendered as a .docx. A user-supplied
 * .docx is ALSO re-rendered (its text extracted and rebuilt) whenever a
 * keyword + backlink URL are requested, so the uploaded copy always carries
 * the link. Returns the path to upload.
 */
const UPLOADABLE_EXTS = new Set([
  ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".ppsx", ".potx", ".odp", ".odt", ".rtf",
]);

export async function toUploadableDoc({ filePath, keyword = "", url = "", title = "", dir = defaultDocDir() } = {}) {
  if (!filePath) return filePath;
  if (RENDERED_DOCX_PATHS.has(filePath)) return filePath;
  const ext = path.extname(filePath).toLowerCase();
  const wantsLink = Boolean(String(keyword).trim() && String(url).trim());

  // A real user .docx that must carry the backlink: extract its text and
  // re-render it with the keyword hyperlinked. When extraction fails (or no
  // backlink was requested) the original file is uploaded untouched.
  if (ext === ".docx" && wantsLink) {
    const xml = extractDocxXml(filePath);
    const text = docxXmlToText(xml);
    if (text) {
      const buf = await buildDocxBuffer({ text, keyword, url, title });
      fs.mkdirSync(dir, { recursive: true });
      const docxPath = path.join(dir, `${fileNameSafe(title || "post")}-${Date.now()}.docx`);
      fs.writeFileSync(docxPath, buf);
      RENDERED_DOCX_PATHS.add(docxPath);
      console.info(`[bodyDocument] re-rendered .docx with "${keyword}" linked to ${url} -> ${path.basename(docxPath)}`);
      return docxPath;
    }
    console.warn(`[bodyDocument] could not extract text from ${path.basename(filePath)} — uploading as-is (no backlink).`);
    return filePath;
  }

  if (UPLOADABLE_EXTS.has(ext)) return filePath;

  const raw = fs.readFileSync(filePath);
  const text = raw.toString("utf8");
  if (text.includes("\u0000")) {
    console.warn(`[bodyDocument] unsupported binary document ${path.basename(filePath)} — leaving as-is.`);
    return filePath;
  }

  fs.mkdirSync(dir, { recursive: true });
  const base = `${fileNameSafe(title || "post")}-${Date.now()}.docx`;
  const docxPath = path.join(dir, base);
  const buf = await buildDocxBuffer({ text, keyword, url, title });
  fs.writeFileSync(docxPath, buf);
  RENDERED_DOCX_PATHS.add(docxPath);
  return docxPath;
}