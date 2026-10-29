# Behance Backlink Automator

Automate **backlink creation** by submitting a blog/project to directory & publishing
platforms. It starts with **Behance** and is built so any website can be added.

```
user input ──► workflow repository (load)        ──► workflow engine ──► Playwright browser
                │              ▲                        (map fields)          │
                ▼              └── saved ── validate ──┘                      ▼
           browser agent discovers site ──►               fill title / body / tags / category /
           (needs login? create button?           upload cover image ─► click Publish
            fields? publish button?)                    │
                                                        ▼
                       submission store (status + published URL) ◄── verify result (live URL)
```

## Flow

1. **Collect input** — the user provides: website name/URL, blog title, category,
   tags, visibility (public/private), description/content, cover image, and an
   optional backlink URL to mention in the post.
2. **Workflow repository check** — if a workflow already exists for that site
   (`workflows/<site>.workflow.json`), it is loaded and reused.
3. **Browser-agent discovery** — otherwise a Playwright browser opens the site,
   detects the login wall, finds the create/publish entry point, catalogues every
   form control (title/description/category/tags/visibility), locates the cover
   upload and the Publish button, then **generates**, **validates** and **saves**
   the workflow.
4. **Workflow engine** — maps the user input onto the site's fields and executes
   each recorded step in the real browser.
5. **Verify** — reloads the resulting URL (or candidates) and checks for the post
   title / success selectors.
6. **Save result** — a submission record is appended to `data/submissions.json`
   with status (`published` / `pending` / `failed`) and the published URL.

## Quick start

```bash
npm install
npm run discover          # optional: pre-discover the site's workflow
npm start                 # full pipeline (collect input -> publish -> verify -> record)
```

> **Behance requires a login to publish.** Put your credentials in `.env` first:

```bash
cp .env.example .env      # then fill in BEHANCE_EMAIL / BEHANCE_PASSWORD
```

The session survives restarts via `data/session.json` (Playwright `storageState`).

## CLI

| Command | What it does |
| --- | --- |
| `npm start` | Interactive full pipeline |
| `npm run discover` | Discover & save the site workflow without publishing |
| `node src/index.js --list-workflows` | List saved workflows |
| `node src/index.js --no-headless` | Run with a visible browser (debugging) |
| `AUTOMATOR_SLOWMO=150 npm start` | Slow each action down for debugging |

## Environment variables (`.env`)

| Variable | Purpose |
| --- | --- |
| `BEHANCE_EMAIL` / `BEHANCE_PASSWORD` | Login credentials |
| `AUTOMATOR_HEADLESS=0` | Show the browser |
| `AUTOMATOR_SLOWMO=150` | Delay between actions (ms) |
| `AUTOMATOR_TIMEOUT` | Playwright timeout (ms, default 45000) |

## Where things live

```
workflows/<site>.workflow.json   generated/validated workflow (steps, selectors, field map)
data/submissions.json            submission history: status + published URL
data/session.json                persisted login session
artifacts/screenshots/           page screenshots on failure / during discovery
```

## Project layout (src/)

| Path | Responsibility |
| --- | --- |
| `input/collector.js` | Interactive questions (title, image, tags, ...) |
| `workflow/repository.js` | Load / save / validate workflow files |
| `workflow/agent.js` | Browser agent: discover → generate → validate → save |
| `workflow/engine.js` | Map input to fields + run steps via Playwright |
| `actions/actions.js` | Playwright action primitives (goto/click/fill/select/upload/wait/press) |
| `verify/verifier.js` | Confirm the post went live |
| `storage/submissionStore.js` | Persist submission status + published URL |
| `orchestrator.js` | Glues the pipeline together |

## Adding another website

Run `npm run discover` and answer the prompts with a different site URL (once
logged in on that site). A new `workflows/<site>.workflow.json` is created and
the same pipeline works against it. Workflow steps can also be hand-edited in
JSON (same schema used by the engine).

## Notes

- Behance exposes its create/publish editor only to authenticated users: the
  agent records login steps and (with credentials) persists a session, then
  captures the real editor + publish selectors. Without credentials it saves a
  partial workflow and tells you what's missing.
- Automated posting may violate a site's terms of service. Only automate
  accounts/sites you own or are allowed to post to.