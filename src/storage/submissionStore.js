import { config } from "../config.js";
import { readJson, writeJson } from "../common/util.js";

/**
 * Submission store — records every submission attempt with its status and
 * the published URL (retrievable list). Persisted to data/submissions.json.
 */
export function recordSubmission(record) {
  const all = readJson(config.submissionsFile, []);
  const entry = {
    id: `sub-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    site: record.site,
    siteUrl: record.siteUrl,
    title: record.title,
    category: record.category,
    tags: record.tags,
    visibility: record.visibility,
    backlinkUrl: record.backlinkUrl,
    bodyDocumentUrl: record.bodyDocumentUrl || "",
    bodyContentMode: record.bodyContentMode || "text",
    status: record.status,
    publishedUrl: record.publishedUrl,
    workflowUsed: record.workflowUsed,
    stepSummary: record.stepSummary,
    createdAt: record.createdAt || new Date().toISOString(),
    source: record.source || "workflow-engine",
    error: record.error || "",
  };
  all.push(entry);
  writeJson(config.submissionsFile, all);
  return entry;
}

export function listSubmissions() {
  return readJson(config.submissionsFile, []);
}

export function summary() {
  const all = listSubmissions();
  return {
    total: all.length,
    published: all.filter((s) => s.status === "published").length,
    pending: all.filter((s) => s.status === "pending").length,
    failed: all.filter((s) => s.status === "failed").length,
  };
}