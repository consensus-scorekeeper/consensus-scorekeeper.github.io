# CLAUDE.md

Notes for Claude Code working in this repo.

## Pages, one shared library

Two root pages and one folder-per-tournament under `tournaments/`. All
share `styles/main.css` and the contents of `src/`:

- `index.html` → the live scorekeeper. Boots the scoring UI, parses the
  uploaded packet (`.pdf`, `.zip` of PDFs, `.docx`, or `.txt`), drives all
  the in-game features.
- `stats.html` → legacy redirect notice. Old bookmarks land here and
  meta-refresh to `tournaments/` after a few seconds.
- `tournaments/index.html` → the **public stats hub**. Lists every
  tournament in `TOURNAMENTS` (see `src/ui/roster-presets.js`) as a
  clickable card, with a search filter. New tournaments show up here
  by appending to the registry.
- `tournaments/<slug>/index.html` → per-tournament stats viewer. Loads
  CSVs from `tournaments/<slug>/results/` via that folder's
  `manifest.json`. Title + heading are stamped by `stats-main.js` from
  the matching `TOURNAMENTS` entry (looked up by the `<meta
  name="tournament-slug">` tag in the page).
- `tournaments/<slug>/rules-slides.html` → optional per-tournament rules
  briefing (a self-contained slide deck).

Each page has its own entry-point JS:
- `src/main.js` — scorekeeper
- `src/stats-main.js` — per-tournament stats viewer
- `src/tournaments-main.js` — hub list + search filter

There is no bundler — `serve.py` (or any static server) serves the files
directly.

## Project shape

```
index.html                                       ← scorekeeper shell
stats.html                                       ← legacy redirect → tournaments/
styles/main.css                                  ← shared stylesheet
tournaments/
  index.html                                     ← stats hub (lists every tournament)
  <slug>/
    index.html                                   ← per-tournament stats page
    rules-slides.html                            ← per-tournament rules briefing (optional)
    results/
      manifest.json                              ← auto-regenerated on push
      *.csv                                      ← exported games (drop CSVs here)
src/
  main.js               ← scorekeeper entry: imports modules, wires DOM, loadState()
  stats-main.js         ← per-tournament-stats-page entry: reads slug from <meta>,
                          stamps title from TOURNAMENTS[slug], loads results/manifest.json
  tournaments-main.js   ← tournaments/index.html entry: hub list + search filter
  state.js              ← state singleton + reducers + subscribe()
  loader.js             ← parsePdf / parseDocx / parseTextFile / processZipBuffer / handleZipUpload orchestrators (.docx + .txt share an applyTextPackResult helper)
  parser/
    zip.js              ← readZip (optional accept(name) filter), looksLikePdfOrZip
    pdf-text.js         ← extractRichLinesFromPdf (pdf.js → lines/segments/posMap)
    questions.js        ← parseQuestions + cleanTrailing + extractRichRange + richToHtml
    docx-text.js        ← extractDocxParagraphs (zip → word/document.xml → runs[])
    docx-questions.js   ← parseDocxBuffer + inferStreakSlotCount (JS port of scripts/parse_consensus_docx.py)
    text-pack.js        ← parseTextPack: normalize a plain-text pack into the rich-segment shape parseQuestions consumes
  game/
    streaks.js          ← rebuildStreakGroups
    jailbreak.js        ← rebuildJailbreakLocks
    categories.js       ← getInitials, getAnsweredBy, getSplitPair, getCategoryRunSize
    persistence.js      ← saveState, loadPdfBytes, savePdfBytes, clearSavedPdfBytes, clearSavedState, isGameVisible
  ui/
    setup.js            ← roster CRUD + Tournament-rosters on/off toggle + tournament picker
    roster-presets.js   ← TOURNAMENTS registry (slug + rosters + description; no statsPage —
                          link is derived from slug). + DEFAULT_TOURNAMENT
                          + PLAYER_SUGGESTIONS + getTournamentBySlug
    drag-reorder.js     ← attachDragReorder: HTML5 drag handler for roster lists / panels
    game.js             ← renderGame (single state subscriber), renderQuestion, etc.
    pdf-viewer.js       ← inline + fullscreen pdf.js viewer
    scoreboard-popout.js ← BroadcastChannel + popout HTML template
    pack-browser.js     ← PACK_CATALOG, fetchWithFallback, renderBrowser
    keybinds.js         ← global keydown listener
    splitter.js         ← attachSplitter
    dev-tools.js        ← reparseCurrentPdf, applyCustomAward, populateCustomAward
    tutorial.js         ← startTutorialGame: boots a sandbox session w/ preset rosters + pack
    tutorial-overlay.js ← 13-step coach-marks overlay engine (multi-target highlight)
    tournament-stats.js ← setupTournamentStats: manifest fetch + view router
    format-pack.js      ← "Format your own pack" modal: fills assets/text-pack-llm-prompt.txt
                          with user-pasted raw questions, copies prompt to clipboard, then
                          loads the LLM's reformatted output via parseTextFile
  util/
    escape.js           ← escapeHtml, csvEscape
    csv.js              ← buildResultsCsv, buildResultsFilename (used by exportCsv)
    parse-results-csv.js ← parseResultsCsv: round-trip of buildResultsCsv output
    tournament-aggregate.js ← aggregateTournament + gamesForTeam + gamesForPlayer
assets/
  tutorial-pack.pdf     ← bundled pack the tutorial sandbox loads
scripts/                ← Python helpers; run from anywhere (paths use __file__)
  serve.py is at root   ← local dev server (port 8000); also /proxy/ for consensustrivia.com
  scrape_packs.py       ← regenerates ui/pack-browser.js's PACK_CATALOG
  generate_fake_tournament.py  ← writes a round-robin into tournaments/<slug>/results/
  update_manifests.py          ← rewrites manifest.json in every tournaments/*/results/ folder
  parse_consensus_docx.py      ← offline .docx → JSON/text dump; reference implementation
                                  for src/parser/docx-questions.js — keep the two in sync
.github/workflows/
  update-manifest.yml   ← auto-regenerates manifests on push (see below)
tests/                  ← vitest tests; run with `npm test`
```

## Architecture conventions

- **State mutations go through reducers in `src/state.js`** (addPoints,
  undoLast, clearCurrentQuestion, resetStreak, applyCustomAward,
  clearPlayerPoints). UI modules call these — they should never write to
  `state.foo` directly.
- **State change → re-render** is wired via a single `subscribe(renderGame)`
  call inside `setupGameScreen()`. Every reducer ends with `notify()`.
- **Inline `onclick=""` is forbidden in index.html.** Static buttons use
  `data-action="..."` and are dispatched by the table in `src/main.js`.
  Dynamically rendered buttons (player panels, sidebar, roster, stats
  tables) use delegated listeners on a stable parent — see each `setupX()`.
- **Pure logic lives outside `ui/`.** Anything that touches `document` or
  `window` belongs in `ui/` or `loader.js`; anything else should be unit
  testable without a DOM. The whole `util/` tree (parse-results-csv,
  tournament-aggregate, csv, escape) is DOM-free.
- **Persistence keys are namespaced and versioned.** Each subsystem owns
  its own localStorage key:
  - `consensus-state-v1`             — saved scorekeeper game (game/persistence.js)
  - `consensus-stats-pdf-v1`         — saved PDF bytes (game/persistence.js). Cleared on `.docx` upload via `clearSavedPdfBytes()` so the inline viewer doesn't try to render a stale PDF from the previous pack.
  - `consensus-roster-mode-v1`       — 'custom' (default) or 'preset'; legacy 'tournament' is migrated to 'preset' on read (ui/setup.js)
  - `consensus-tournament-slug-v1`   — which TOURNAMENTS entry drives the preset team-name dropdown (ui/setup.js)
- **Multiple pages share modules**, so anything imported by `stats-main.js`
  or `tournaments-main.js` must not assume scorekeeper-only DOM exists.
  `tournament-stats.js`, the util modules, and `roster-presets.js` are
  page-agnostic; everything else in `ui/` (setup.js, game.js, pdf-viewer.js,
  etc.) is index.html-only.

## Roster mode toggle

The setup screen has a top-right toggle labeled **"Tournament rosters"**
with a pill switch that reads ON or OFF, plus a tournament-picker
dropdown that appears alongside ON:

- **Tournament rosters: OFF** (default) — team-name field is a free-text
  `<input>`. Rosters are built manually. The tournament picker is hidden.
- **Tournament rosters: ON** — team-name field is a `<select>` populated
  from the chosen tournament's `rosters`. The picker (`Rosters from
  <select>`) lists every entry in `TOURNAMENTS`; changing it clears the
  current teams and repopulates the dropdowns from the newly chosen
  tournament. Adding a player offers an autocomplete `<datalist>` of
  every name across every tournament.

The add-player `<datalist>` is also gated on mode: in `custom` mode
`populatePlayerSuggestions()` empties it, so a manually-typed roster
isn't nudged toward names from tournaments the user isn't running. The
toggle re-runs `populatePlayerSuggestions()` so suggestions flip on/off
immediately.

Internally the modes are named `custom` and `preset`. The legacy
`'tournament'` value is migrated to `'preset'` on read for users on older
localStorage state.

Mode is mirrored onto `#setup` as `data-roster-mode="…"` so CSS-only
sections can show/hide themselves without JS coordination.

`setTeamNameField(team, name)` is the mode-aware setter that
`loadState`, `tutorial.js`, and the toggle itself use to display a name
in whichever element is currently mounted.

## Packet upload — `.pdf` vs `.zip` vs `.docx` vs `.txt`

The file picker (`#pdf-input`, `accept=".pdf,.zip,.docx,.txt"`) dispatches
in `src/main.js` by extension:

- **`.pdf`** → `parsePdf` (`loader.js`). pdf.js extracts rich text with
  font + position info; `parseQuestions` turns it into the canonical
  question shape; `state.pdfBytes` is saved so the inline PDF viewer can
  render pages.
- **`.zip`** → `processZipBuffer` → `handleZipUpload`. `readZip` walks
  the central directory, the dropdown gets one entry per PDF, and the
  first selection auto-loads. The zip path is PDFs-only at the moment.
- **`.docx`** → `parseDocx` (`loader.js`). `extractDocxParagraphs`
  reads `word/document.xml` out of the docx (which is itself a zip) and
  yields `[{ text, bold }]` runs; `parseDocxBuffer` runs the same state
  machine as `scripts/parse_consensus_docx.py` and emits questions in
  the PDF-parser's shape.
- **`.txt`** → `parseTextFile` (`loader.js`). `parseTextPack` normalizes
  the text into a synthetic line-list with bold flags and feeds it to
  the PDF parser's `parseQuestions`, so the same propagation /
  streakRange logic applies. The "Format pack" modal
  (`ui/format-pack.js`) lets users generate this format from raw input
  via an LLM prompt fetched from `assets/text-pack-llm-prompt.txt`.

`parseDocx` and `parseTextFile` share an `applyTextPackResult({
filename, parseFn, parsingMessage, errorPrefix })` helper that handles
the post-parse work (slot count, status message, persistence). Both
clear `state.pdfBytes` and call `clearSavedPdfBytes()` so the inline
viewer hides itself for non-PDF packs and a reload doesn't resurrect a
stale PDF.

All four upload paths produce identical-shape question records, so
everything downstream (`padQuestionsToSlots`, `startGame`,
`rebuildStreakGroups`, scoring, CSV export) doesn't know or care which
upload path produced them.

### Streak-slot inference (docx-only)

In a PDF packet the streak's slot span is encoded by the gap between
the streak's question number and the next question's number (e.g.
`85.` … `90.` → slots 85–89). The `.docx` format has no question
numbers, so `inferStreakSlotCount(prompt, answerCount)` reads it from
the streak's prompt:

1. Look for `up to (all) N` / `name N` / `give N` (digit or
   `one`..`twelve`) in the prompt — writers sometimes list more
   accepted answers than the cap allows, so the prompt is more
   authoritative than the `A:` count.
2. Fall back to `answerCount` if no cap is found.
3. Return `max(1, ceil(cap / 2))` — each streak answer is worth half
   points, so `N` accepted answers ≈ `N/2` regular-question slots.

If you change this heuristic, update both
`src/parser/docx-questions.js` and `scripts/parse_consensus_docx.py`
together. Both have a `CAP_RE` and an `inferStreakSlotCount` you can
keep in lockstep.

## Adding a new tournament

The site hosts one folder per tournament under `tournaments/`. To add
one:

1. Append a new entry to `TOURNAMENTS` in `src/ui/roster-presets.js`:
   `{ name, slug, description, rosters: [{name, players}, ...] }`. The
   slug doubles as the URL path under `tournaments/<slug>/`.
2. Create `tournaments/<slug>/index.html` as a copy of
   `tournaments/stanford-consensus-2026/index.html`, updating the single
   `<meta name="tournament-slug" content="...">` to the new slug. The
   page is otherwise generic — `stats-main.js` looks up the matching
   TOURNAMENTS entry and stamps title + heading.
3. Drop the tournament's CSVs into `tournaments/<slug>/results/`. The
   auto-manifest workflow regenerates `manifest.json` on push.
4. Optionally add `tournaments/<slug>/rules-slides.html` if the
   tournament has a rules briefing — the per-tournament page links to it
   automatically if present.

The hub (`tournaments/index.html`) auto-discovers the new entry — it
renders one card per TOURNAMENTS entry with the link derived from
`<slug>/`.

## Tutorial

`startTutorialGame()` (`src/ui/tutorial.js`) boots a sandbox session:

- Sets `state.tutorialMode = true` so saveState / savePdfBytes early-return
  and the tutorial doesn't pollute the user's saved game.
- Loads `assets/tutorial-pack.pdf`, applies preset rosters, calls
  `startGame()`, then triggers `startTutorial()` from
  `src/ui/tutorial-overlay.js`.
- `exitTutorial()` reloads the page, which both clears `tutorialMode` and
  restores any pre-tutorial saved game.

The overlay supports multi-target highlights (the `target` field accepts
either a CSS selector string or an array — first match gets the dim
spotlight, the rest get an outline only). Step 10 uses this to highlight
±Points + the inline PDF + the Hide-PDF toggle simultaneously.

## Tournament stats (per-tournament pages)

Each per-tournament HTML at `tournaments/<slug>/index.html` is a generic
shell that loads `src/stats-main.js`. The shell loads CSVs exclusively
from the tournament's own manifest:

- **Manifest auto-load** — `tournaments/<slug>/results/manifest.json`
  (shape `{"games": [...]}`) is fetched on every page load. Each entry
  is a filename inside the same directory.

User-uploaded CSVs are intentionally not supported on the public page —
the published data is the only source. Manifest regeneration is owned by
the GitHub workflow described below.

Views (state machine in `tournament-stats.js`):

- `standings` — team table stacked above individual leaderboard
  (full-width to avoid horizontal scroll), plus a summary card.
- `team` — record + games + per-player totals; click a row to drill in.
- `player` — per-game performance for one player on one team (matches
  on `(name, team)` so same-name-different-team players don't collide).
- `game` — full per-player breakdown for both sides.

Pure logic for these lives in `src/util/tournament-aggregate.js`
(`aggregateTournament`, `gamesForTeam`, `gamesForPlayer`) and
`src/util/parse-results-csv.js` — both unit-tested without a DOM.

### Auto-manifest workflow

Every per-tournament stats page loads its own
`tournaments/<slug>/results/manifest.json` to know which CSVs to fetch.
**You don't write any manifest by hand.** The
`.github/workflows/update-manifest.yml` Action regenerates every
affected manifest on every push that touches `tournaments/*/results/`,
so the maintainer's flow is:

1. Drop CSV(s) into `tournaments/<slug>/results/`
2. `git add` + commit + push

The Action runs `python scripts/update_manifests.py`, which walks every
`tournaments/*/results/` folder and rewrites its `manifest.json` if the
contents drifted. The path filter excludes the manifest files themselves
so the bot's own commit doesn't bounce the workflow.

`scripts/update_manifests.py` is also a manual fallback for local dev
(when running `python serve.py` against an unpushed checkout).
`scripts/generate_fake_tournament.py` re-rolls the demo data into
`tournaments/fake-round-robin-2026/results/` and writes that folder's
manifest at the end.

## Tests

```
npm install         # one-time: installs vitest + happy-dom
npm test            # runs all tests once
npm run test:watch  # watch mode
```

Tests live in `tests/*.test.js`. They import from `../src/main.js` (which
re-exports the public surface) so a future module split inside `src/` is
transparent to tests. Notable test files:

- `parse-questions.test.js`        — synthetic PDF input → parsed questions
- `state-mutations.test.js`        — reducer correctness
- `export-csv.test.js`             — CSV layout snapshot (keep multi-section format intact)
- `parse-results-csv.test.js`      — round-trip of the CSV exporter
- `tournament-aggregate.test.js`   — standings sort, leaderboard, per-team / per-player
- `tournament-fixtures.test.js`    — runs every CSV in `assets/tournament-results/`
                                     through parse + aggregate, plus asserts the manifest
                                     stays in sync with the folder

If you add stats functionality, add fixtures + assertions there so the
manifest can't silently drift.

## Regenerating the pack catalog

`PACK_CATALOG` lives in `src/ui/pack-browser.js` and drives the "browse
packs from consensustrivia.com" UI. Each entry encodes the level, season,
tournament name, URL slug (`dir`), file-name prefix, and number of packs.
The site grows over time — championships in particular accumulate packs
past the original count of 10 — so the catalog needs occasional refreshing.

`scripts/scrape_packs.py` walks the two index pages
(`/post-secondary/packs.html`, `/high-school/packs.html`), follows each
tournament's detail page, counts the `Pack N.pdf` links, and prints a
drop-in JS catalog snippet. It uses only the Python standard library
(`urllib`, `html.parser`).

### How to run

On this machine the default `python` shim points at the Microsoft Store
stub (not actually installed). Use the miniforge interpreter explicitly:

```
& "C:\Users\denis\miniforge3\python.exe" scripts\scrape_packs.py
```

Or from a regular shell where Python is on PATH:

```
python scripts/scrape_packs.py
```

Output:
- **stdout** — a `const PACK_CATALOG = [ ... ];` block.
- **stderr** — per-tournament progress (season, name, detail URL, pack count).

### Applying the output

Replace the existing `PACK_CATALOG = [ ... ];` block in
`src/ui/pack-browser.js` with the stdout snippet. The schema is identical
to what's already there, so nothing else needs to change. Spot-check the
diff for any tournament whose pack count dropped — that would suggest the
site reorganized something the scraper didn't anticipate.

### When to re-run

- Any time someone reports a missing pack in the browser UI.
- After a new tournament is announced on consensustrivia.com.
- When a championship advances and adds more rounds (these regularly grow
  past 10 packs).

### What the scraper assumes

- Tournament detail pages link directly to each `Pack N.pdf` with the
  canonical filename (`<prefix> Pack <N>.pdf`).
- The high-school index lists divisions inline as `<li>Tournament Name
  (<a>junior</a> | <a>high school</a>)</li>`. Division-to-suffix mapping
  is hard-coded in `DIVISION_SUFFIX` (junior → " (Junior)", "high school"
  → "", "B division" → " (B)") to match the existing display names.
- Season is extracted from the nearest enclosing heading via
  `\d{4}-\d{2}`.

If the site changes its markup, those assumptions are the first places
to look.
