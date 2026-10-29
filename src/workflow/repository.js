import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { readJson, writeJson } from "../common/util.js";

export function workflowKey(siteUrl) {
  const clean = String(siteUrl || "").trim();
  const u = new URL(clean.startsWith("http") ? clean : `https://${clean}`);
  return u.hostname.replace(/^www\./, "").replace(/\./g, "-");
}

export function workflowPath(siteUrl) {
  return path.join(config.workflowsDir, `${workflowKey(siteUrl)}.workflow.json`);
}

export function findWorkflow(siteUrl) {
  const file = workflowPath(siteUrl);
  const workflow = readJson(file, null);
  return workflow ? { workflow, file } : null;
}

export function listWorkflows() {
  if (!fs.existsSync(config.workflowsDir)) return [];
  return fs
    .readdirSync(config.workflowsDir)
    .filter((f) => f.endsWith(".workflow.json"))
    .map((f) => readJson(path.join(config.workflowsDir, f), null))
    .filter(Boolean);
}

export function saveWorkflow(siteUrl, workflow) {
  const file = workflowPath(siteUrl);
  const enriched = {
    ...workflow,
    site: siteUrl,
    savedAt: new Date().toISOString(),
  };
  writeJson(file, enriched);
  return file;
}

export function deleteWorkflow(siteUrl) {
  const file = workflowPath(siteUrl);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    return true;
  }
  return false;
}

export function isValidWorkflow(w) {
  if (!w) return false;
  if (!Array.isArray(w.steps) || w.steps.length === 0) return false;
  const idSet = new Set();
  for (const s of w.steps) {
    if (!s.id || !s.action || typeof s.action !== "string") return false;
    if (idSet.has(s.id)) return false;
    idSet.add(s.id);
    if (!["goto", "click", "fill", "select", "upload", "wait", "press", "check", "type", "tags", "autocomplete", "hypertext", "captcha"].includes(s.action)) return false;
  }
  return true;
}