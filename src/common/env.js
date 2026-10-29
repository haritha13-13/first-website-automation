import fs from "node:fs";
import { config } from "../config.js";

/**
 * Reads the .env file in the project root (if present) into process.env.
 * Values from the real environment always win.
 */
export function loadEnv() {
  if (!fs.existsSync(config.envFile)) return;
  const lines = fs
    .readFileSync(config.envFile, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith("#"));
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function env(name, fallback = "") {
  return process.env[name] || fallback;
}