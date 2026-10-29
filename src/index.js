#!/usr/bin/env node
import { runPipeline, printSavedWorkflows } from "./orchestrator.js";
import { loadEnv } from "./common/env.js";
import { config } from "./config.js";
import { requestStop } from "./browser/browser.js";
import { error, logSection, warn, info } from "./common/util.js";

// Ctrl+C / Ctrl+Break / kill should close the browser and stop cleanly, never
// leave the process spinning against a closed browser context.
let interrupted = false;
const onSignal = (code) => async () => {
  if (interrupted) process.exit(code); // second press = force quit
  interrupted = true;
  logSection("Stopping (Ctrl+C) — closing the browser cleanly…");
  await requestStop();
  setTimeout(() => process.exit(code), 3000); // safety net if a loop never returns
};
process.on("SIGINT", onSignal(130));
process.on("SIGTERM", onSignal(143));

const args = process.argv.slice(2);

async function main() {
  loadEnv();

  logSection("Behance Backlink Automator");

  if (args.includes("--list-workflows") || args.includes("-l")) {
    printSavedWorkflows();
    return;
  }

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage:
  npm start                        Interactive: collect input -> run (load or discover) workflow -> publish -> verify -> record
  npm run discover                 Discover & save workflow for a site without publishing
  node src/index.js --list         Show saved workflows
  node src/index.js --no-headless  Run with a visible browser window

Environment (.env or shell):
  BEHANCE_EMAIL / BEHANCE_PASSWORD   login credentials (persisted session in data/session.json)
  AUTOMATOR_HEADLESS=0               visible browser
  AUTOMATOR_SLOWMO=150               slow each action for visible debugging
`);
    return;
  }

  const discoverOnly = args.includes("--discover-only");

  // --no-headless forces a visible browser window (equivalent to
  // AUTOMATOR_HEADLESS=0), overriding any default/headless config.
  if (args.includes("--no-headless")) {
    process.env.AUTOMATOR_HEADLESS = "0";
    config.browser.headless = false;
  }

  // A live browser window is the whole point of this tool — the user watches
  // the agent fill the editor and solves CAPTCHAs. On a desktop (WSLg/X11) a
  // bare `npm start` must therefore open the visible window automatically, not
  // run invisible headless. Only an explicit AUTOMATOR_HEADLESS=1 (or an
  // environment with no display server) keeps it headless.
  if (!config.browser.headless) {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      warn("Visible browser requested but no display server is reachable (DISPLAY/WAYLAND_DISPLAY unset).");
      warn("If you're on WSLg, run with:  AUTOMATOR_HEADLESS=0 DISPLAY=:0 npm start");
    }
  } else if (process.env.AUTOMATOR_HEADLESS !== "1" && args.includes("--no-headless") === false) {
    const hasDisplay = Boolean(
      process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.env.WSL_DISPLAY
    );
    if (hasDisplay) {
      process.env.AUTOMATOR_HEADLESS = "0";
      config.browser.headless = false;
      info("Display detected (WSLg/X11) — running with a VISIBLE browser window so you can watch the live run.");
    } else {
      warn("No display detected — running headless (no live window). To watch live: AUTOMATOR_HEADLESS=0 DISPLAY=:0 npm start");
    }
  }

  try {
    const result = await runPipeline({
      discoverOnly,
    });
    if (result && result.status === "interrupted") process.exitCode = 130;
  } catch (err) {
    error((err && err.stack ? err.stack.split("\n").slice(0, 4).join("\n") : String(err)));
    process.exitCode = 1;
  }
}

main();