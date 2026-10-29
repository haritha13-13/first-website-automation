import fs from "node:fs";
import path from "node:path";
import { input, password, confirm, select, editor } from "@inquirer/prompts";
import { logSection, slugify } from "../common/util.js";

/**
 * Collects all blog submission details from the user interactively.
 */
export async function collectDiscoveryInput() {
  logSection("Discovery Input");
  const siteName = await input({
    message: "Website name (target platform, e.g. Behance):",
    default: "Behance",
  });
  const siteUrl = await input({
    message: "Website URL:",
    default: "https://www.behance.net/",
    validate: (v) => {
      try {
        new URL(v);
        return true;
      } catch {
        return "Enter a valid URL (include https://)";
      }
    },
  });
  const useLogin = await confirm({ message: "Log in during discovery (needed for Behance)?", default: true });
  let credentials = null;
  if (useLogin) {
    const email = await input({ message: "Email (or leave blank to use .env):", default: process.env.BEHANCE_EMAIL || "" });
    const pw = await password({ message: "Password (or leave blank to use .env):" });
    credentials = {
      email: email || process.env.BEHANCE_EMAIL || "",
      password: pw || process.env.BEHANCE_PASSWORD || "",
    };
  }
  const siteUsername = await askSiteUsername(siteName, siteUrl);
  return { siteName, siteUrl: normalizeSiteUrl(siteName, siteUrl), credentials, username: siteUsername };
}

/**
 * blogfreely.it identifies its users by a USERNAME (not an email). When the
 * target site is blogfreely, ask for it and carry it through as an input so
 * the workflow can map it (e.g. a login/profile field).
 */
export function isBlogfreelySite(siteName, siteUrl) {
  return /blogfreely/i.test(`${siteName} ${siteUrl}`);
}

/**
 * blogfreely is hosted on blogfreely.net (blogfreely.it does not resolve). If
 * the user means blogfreely but typed another URL, fix it up so discovery and
 * execution actually reach the site.
 */
export function normalizeSiteUrl(siteName, siteUrl) {
  if (!isBlogfreelySite(siteName, siteUrl)) return siteUrl.trim();
  const url = siteUrl.trim();
  if (!url) return "https://blogfreely.net/";
  if (!/blogfreely/i.test(url)) return "https://blogfreely.net/";
  return url.replace(/blogfreely\.it/i, "blogfreely.net");
}

async function askSiteUsername(siteName, siteUrl) {
  if (!isBlogfreelySite(siteName, siteUrl)) return "";
  return input({
    message: "Username for blogfreely (used with the site login/profile):",
    validate: (v) => (v.trim() ? true : "Username is required for blogfreely"),
  });
}

/**
 * Which body-input mode does this site need? Derives from the discovered
 * workflow's input configuration (never per-site hardcoding):
 *  - workflow.inputs.content.mode   -> explicit ("text" | "document")
 *  - fallback: an "upload" step mapped to the body field implies document.
 */
export function contentModeFromWorkflow(workflow) {
  const mode = workflow?.inputs?.content?.mode;
  if (mode === "text" || mode === "document") return mode;
  const steps = workflow?.steps || [];
  const bodyUpload = steps.find((s) => s.property === "bodyDocument");
  if (bodyUpload) return "document";
  return "text";
}

/**
 * Site-level info needed BEFORE a workflow can be loaded or discovered:
 * which site, and the credentials used by discovery / login steps.
 */
export async function collectSiteInput() {
  logSection("Blog Submission Input");

  const siteName = await input({
    message: "Website name (target platform, e.g. Behance):",
    default: "Behance",
    validate: (v) => (v.trim() ? true : "Website name is required"),
  });

  const siteUrl = await input({
    message: "Website URL:",
    default: "https://www.behance.net/",
    validate: (v) => {
      try {
        new URL(v);
        return true;
      } catch {
        return "Enter a valid URL (include https://)";
      }
    },
  });

  const useRealLogin = await confirm({
    message: "Do you want to log in to the site now (credentials from .env BEHANCE_EMAIL/BEHANCE_PASSWORD)?",
    default: true,
  });
  let credentials = null;
  if (useRealLogin) {
    const email = await input({ message: "Email (or leave blank to use .env):", default: process.env.BEHANCE_EMAIL || "" });
    const pw = await password({ message: "Password (or leave blank to use .env):" });
    credentials = {
      email: email || process.env.BEHANCE_EMAIL || "",
      password: pw || process.env.BEHANCE_PASSWORD || "",
    };
  }

  const username = await askSiteUsername(siteName, siteUrl);

  return { siteName, siteUrl: normalizeSiteUrl(siteName, siteUrl), credentials, username };
}

/**
 * Should the given optional submission field be prompted for? A workflow can
 * whitelist the fields its form actually has (workflow.inputs.fields). When the
 * list is absent, every optional field is asked (backwards compatible).
 * The blog content itself ("description") and the review toggle are always asked.
 */
export function siteFieldAsked(workflow, field) {
  const fields = workflow?.inputs?.fields;
  if (!Array.isArray(fields)) return true;
  return fields.includes(field);
}

/**
 * The submission fields that depend on the discovered workflow: the blog
 * content is either typed (text mode) or given as a Document URL (document
 * mode), driven solely by workflow.inputs.content.mode. Optional fields are
 * only prompted when workflow.inputs.fields allows them (e.g. blogfreely has no
 * tags/description/category fields, so its workflow lists only "description").
 */
export async function collectContentInput({ siteName, siteUrl, workflow } = {}) {
  const mode = contentModeFromWorkflow(workflow);
  logSection(`Blog Submission Input (${siteName || siteUrl || "site"} — ${mode} content)`);

  const title = siteFieldAsked(workflow, "title")
    ? await input({
        message: "Blog / Project title:",
        validate: (v) => (v.trim() ? true : "Title is required"),
      })
    : "";

  const category = siteFieldAsked(workflow, "category")
    ? await input({
        message: "Category:",
        default: "",
      })
    : "";

  const tagLine = siteFieldAsked(workflow, "tags")
    ? await input({
        message: "Tags (comma separated):",
        default: "",
      })
    : "";

  const visibility = siteFieldAsked(workflow, "visibility")
    ? await select({
        message: "Visibility:",
        choices: [
          { name: "Public", value: "public" },
          { name: "Private", value: "private" },
        ],
        default: "public",
      })
    : "public";

  let description;
  let bodyDocumentUrl = "";
  if (mode === "document") {
    bodyDocumentUrl = await input({
      message: "Document URL or local file path (the blog content as a document — e.g. .docx/.pdf/.txt):",
      validate: (v) => {
        if (!v.trim()) return "Document URL is required";
        try {
          new URL(v);
          return true;
        } catch {
          const p = path.resolve(v.trim());
          if (fs.existsSync(p)) return true;
          if (/^[~.\/]|(\.|\/)/.test(v.trim()) && /[^.]{2,}$/.test(v.trim()))
            return `File not found: ${p}`;
          return "Enter a valid URL (include https://)";
        }
      },
    });
  } else {
    description = process.env.EDITOR || process.env.VISUAL
      ? await editor({
          message: "Blog content (write the blog body; save & close the editor to continue):",
          validate: (v) => (v.trim() ? true : "Content is required"),
          postfix: ".txt",
        })
      : await input({ message: "Blog content (paste the blog body):" });
  }

  const shortDescription = siteFieldAsked(workflow, "shortDescription")
    ? await input({
        message:
          "Short description for the publish dialog (optional — press Enter to use the full blog body):",
        default: "",
      })
    : "";

  const useCustomImage = siteFieldAsked(workflow, "image")
    ? await confirm({
        message: "Do you want to attach an image (required for Behance project cover)?",
        default: true,
      })
    : false;
  let imagePath = "";
  if (useCustomImage) {
    const candidate = await input({
      message: "Path to cover image (absolute or project-relative):",
      validate: (v) =>
        fs.existsSync(path.resolve(v)) ? true : "File does not exist — check the path",
    });
    imagePath = path.resolve(candidate);
  }

  const backlinkUrl = siteFieldAsked(workflow, "backlinkUrl")
    ? await input({
        message: "Backlink URL (the link/website to mention in the post):",
        default: "",
      })
    : "";

  const keyword = siteFieldAsked(workflow, "keyword")
    ? await input({
        message:
          "Anchor keyword (the word inside the blog content that, when clicked/touched, opens the backlink site):",
        default: "",
      })
    : "";

  // The agent finishes the publish itself; the review pause is OPT-IN only
  // (AUTOMATOR_REVIEW_PUBLISH=1) so a plain run never waits on the human.
  const reviewPublish = await confirm({
    message: "Pause before the final Publish so you can review the filled dialog? (click final Publish yourself)",
    default: process.env.AUTOMATOR_REVIEW_PUBLISH === "1",
  });

  const tags = tagLine
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  return {
    siteName: siteName || (siteUrl ? siteUrl : ""),
    siteUrl: siteUrl || "",
    title,
    slug: slugify(title) || "untitled-post",
    category,
    tags,
    visibility,
    description,
    bodyDocumentUrl,
    bodyContentMode: mode,
    shortDescription,
    imagePath,
    backlinkUrl,
    keyword,
    reviewPublish,
    submittedAt: new Date().toISOString(),
  };
}

/** Backwards-compatible single-call that collects everything (site + content). */
export async function collectInput() {
  const site = await collectSiteInput();
  const content = await collectContentInput({ siteName: site.siteName, siteUrl: site.siteUrl });
  return { ...site, ...content };
}