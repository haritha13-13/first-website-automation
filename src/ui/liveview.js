import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

// --- Minimal PNG decoder (8-bit RGB/RGBA) ----------------------------------
// Enough to turn a Playwright screenshot into a luminance grid for the live
// terminal view. No external deps.
export function decodePng(buffer) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (offset < buffer.length) {
    const len = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    }
    offset += 12 + len;
  }
  const channels = [0, 0, 3, 1, 2, 0, 4][colorType] || 4;
  if (!width || !height) throw new Error("PNG missing IHDR");
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * channels);
  let prev = Buffer.alloc(stride);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      row[x] = v & 0xff;
    }
    prev = row;
  }
  return { width, height, channels, data: out };
}

export function readGrid(data, width, height, channels, cols, rows) {
  const grid = [];
  for (let r = 0; r < rows; r++) {
    const line = [];
    const y0 = Math.floor((r / rows) * height);
    const y1 = Math.max(y0 + 1, Math.floor(((r + 1) / rows) * height));
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor((c / cols) * width);
      const x1 = Math.max(x0 + 1, Math.floor(((c + 1) / cols) * width));
      let lum = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * channels;
          lum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
          n++;
        }
      }
      line.push(n ? lum / n / 255 : 0.5);
    }
    grid.push(line);
  }
  return grid;
}

function printGrid(grid) {
  const lines = [];
  for (const row of grid) {
    let line = "";
    for (const lum of row) {
      const shade = 232 + Math.max(0, Math.min(23, Math.round(lum * 23))); // ANSI 256 grayscale
      line += `\x1b[48;5;${shade}m  `;
    }
    lines.push(line + "\x1b[0m");
  }
  // Move cursor up before redrawing so frames redraw in place.
  process.stdout.write(`\x1b[${lines.length}A\x1b[0J` + lines.join("\n") + "\n");
}

// --- Live view --------------------------------------------------------------
/**
 * Watch the automation live from the terminal: every `intervalMs` the current
 * page is screenshotted, rendered as a coarse grayscale ASCII grid right in the
 * running output, with a status line (URL/title/last action). On headed runs
 * also stores a live PNG the user can open on Windows (`explorer.exe`).
 * Returns { stop }.
 */
export function startLiveView(page, { intervalMs = 2500, cols = 60, rows = 24 } = {}) {
  // Terminal preview is opt-in (AUTOMATOR_LIVE_VIEW=1). By default the crisp
  // watch page in the user's own browser (src/ui/watch.js) is the live view;
  // here we still refresh artifacts/screenshots/live-latest.png every frame.
  const verbatim = process.env.AUTOMATOR_LIVE_VIEW === "1";
  const tty = Boolean(process.stdout.isTTY);
  let active = true;
  let timer = null;
  let firstSeen = false;

  const frame = async () => {
    if (!active || page.isClosed()) return;
    let url = "";
    let title = "";
    try {
      url = page.url();
      title = await page.title().catch(() => "");
    } catch {
      return;
    }
    let png = null;
    try {
      png = await page.screenshot({ type: "png" });
    } catch {
      png = null;
    }
    if (png) {
      fs.mkdirSync(config.screenshotsDir, { recursive: true });
      const liveFile = path.join(config.screenshotsDir, "live-latest.png");
      fs.writeFileSync(liveFile, png);
      firstSeen = true;
      if (verbatim && tty) {
        try {
          const { width, height, channels, data } = decodePng(png);
          const grid = readGrid(data, width, height, channels, cols, rows);
          printGrid(grid);
        } catch {
          /* grid not decodable this frame — status line still updates below */
        }
      }
    }
    if (verbatim) {
      const status = `\x1b[36m[LIVE]\x1b[0m ${title || "(no title)"}  \x1b[90m${url}\x1b[0m`;
      if (tty) process.stdout.write(status + "\n");
      else process.stdout.write(`[LIVE] ${title || "(no title)"} ${url}\n`);
    }
  };

  timer = setInterval(() => {
    frame().catch(() => {});
  }, intervalMs);
  frame().catch(() => {});

  return {
    stop() {
      active = false;
      if (timer) clearInterval(timer);
      process.stdout.write("\n");
    },
  };
}