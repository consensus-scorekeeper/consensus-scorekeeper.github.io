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
- `tournaments/preview.html` → generic **pending-submission preview**
  page (`?slug=<slug>&preview=<issue>`): same stats viewer, slug from the
  query string instead of a meta tag. Exists because a brand-new
  tournament has no published page until its first submission PR merges
  (see "Pending-submission preview" below).

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
  preview.html                                   ← pending-submission preview (?slug=&preview=)
  <slug>/
    index.html                                   ← per-tournament stats page
    rules-slides.html                            ← per-tournament rules briefing (optional)
    results/
      manifest.json                              ← auto-regenerated on push
      *.csv                                      ← exported games (drop CSVs here)
src/
  main.js               ← scorekeeper entry: imports modules, wires DOM, loadState()
  stats-main.js         ← per-tournament-stats-page entry (also drives
                          tournaments/preview.html): slug from <meta> or, failing
                          that, a validated ?slug= param; stamps title from
                          TOURNAMENTS[slug] (deriveTournamentName fallback for
                          unregistered preview slugs), injects the submit-results
                          link + the rules-briefing link (HEAD-probes
                          rules-slides.html — never hardcoded in the shell, which
                          the submission pipeline copies), loads results/manifest.json,
                          passes ?preview=<issue> through to the viewer
  tournaments-main.js   ← tournaments/index.html entry: hub list + search filter
                          + create-tournament link
  state.js              ← state singleton + reducers + subscribe()
  loader.js             ← parsePdf / parseDocx / parseTextFile / processZipBuffer / handleZipUpload
                          orchestrators; every format lands in one applyParseResult()
                          (acceptance gate, status line, state.parseIssues, parse report);
                          zip packs get background per-pack issue annotation
  parser/
    zip.js              ← readZip (optional accept(name) filter), looksLikePdfOrZip
    rich-doc.js         ← the RichDoc IR every adapter emits: makeLine + flattenDoc
    questions.js        ← THE universal parsing core: parseQuestions(doc) → { questions,
                          issues } + computeTotalSlots + cleanTrailing + extractRichRange
                          + richToHtml
    diagnostics.js      ← makeIssue + analyzeQuestions (whole-pack checks) + issueSlotSet
                          + summarizeIssues (pure, DOM-free)
    pdf-text.js         ← pdf adapter: extractRichDocFromPdf (pdf.js → RichDoc;
                          bold = second-most-used font)
    docx-text.js        ← extractDocxParagraphs (zip → word/document.xml → runs[])
    docx-questions.js   ← docx adapter: transpiles paragraphs into canonical numbered
                          lines (sequential nums; streak spans = number gaps from the
                          pack's cumulative streak caps via inferStreakCap) and runs
                          them through parseQuestions
    text-pack.js        ← txt adapter: strict line classifier for the authored format,
                          emits line-numbered txt-* issues, feeds parseQuestions
  game/
    streaks.js          ← rebuildStreakGroups
    jailbreak.js        ← rebuildJailbreakLocks
    categories.js       ← getInitials, getAnsweredBy, getSplitPair, getCategoryRunSize
    persistence.js      ← saveState, loadPdfBytes, savePdfBytes, clearSavedPdfBytes, clearSavedState, isGameVisible
  ui/
    setup.js            ← roster CRUD + Tournament Mode on/off toggle + tournament picker
    roster-presets.js   ← TOURNAMENTS registry (slug + rosters + description; no statsPage —
                          link is derived from slug) — stats-pages-only
                          + playerSuggestionsFor + getTournamentBySlug
    custom-tournaments.js ← user-created tournaments (localStorage) — the only
                          entries the Tournament Mode picker shows:
                          loadCustomTournaments, getCustomTournamentBySlug,
                          generateSlug (never shadows a registry slug)
    roster-manager.js   ← "My tournaments" modal: create/edit/delete/export/import
                          custom roster sets (list + editor views)
    modal.js            ← shared modal plumbing: setStatus + wireModalDismiss
                          (used by roster-manager.js)
    download.js         ← downloadTextFile: Blob + anchor-click browser download
    drag-reorder.js     ← attachDragReorder: HTML5 drag handler for roster lists / panels
    game.js             ← renderGame (single state subscriber), renderQuestion, etc.
    pdf-viewer.js       ← inline + fullscreen pack viewer: pdf.js canvas for PDFs,
                          rendered state.packDoc text for .docx/.txt packs
    scoreboard-popout.js ← BroadcastChannel + popout HTML template
    pack-browser.js     ← PACK_CATALOG (consensustrivia, scraper-generated) +
                          GRADWRITE_CATALOG (gradwritetrivia.org, hand-maintained)
                          + renderBrowser + fetchWithFallback (direct fetch when
                          the source sends CORS (gradwrite) → serve.py /proxy/
                          (local dev) → our Cloudflare Worker (PACK_PROXY_BASE,
                          source in workers/pack-proxy/) → public CORS proxies
                          → manual download-it-yourself link)
    keybinds.js         ← global keydown listener
    splitter.js         ← attachSplitter
    dev-tools.js        ← reparseCurrentPdf, applyCustomAward, populateCustomAward
    tutorial.js         ← startTutorialGame: boots a sandbox session w/ preset rosters + pack
    tutorial-overlay.js ← 13-step coach-marks overlay engine (multi-target highlight)
    tournament-stats.js ← setupTournamentStats: manifest fetch + view router
                          + pending-submission preview overlay (loadPreview:
                          GitHub API + raw.githubusercontent fetches, banner)
    submission-links.js ← DOM builders for the submit-results / create-tournament
                          links (both open the GitHub issue form via
                          util/submit-results.js); submit-results on every
                          per-tournament page (stats-main.js), create-tournament
                          on the hub only (tournaments-main.js) — page-agnostic
    parse-report.js     ← renderParseReport: the "suspected parsing issues" panel under
                          the upload status (reads state.parseIssues)
  util/
    escape.js           ← escapeHtml, csvEscape
    csv.js              ← buildResultsCsv, buildResultsFilename (used by exportCsv)
    submit-results.js   ← submitResultsUrl: URL of the GitHub submit-results issue
                          form (slug prefilled when given); rendered as links by
                          ui/submission-links.js
    parse-results-csv.js ← parseResultsCsv: round-trip of buildResultsCsv output
    tournament-aggregate.js ← aggregateTournament + gamesForTeam + gamesForPlayer
    roster-text.js      ← parseRosterText / serializeRosterText / slugifyName:
                          the plain-text roster format (pure, DOM-free)
    submission.js       ← splitCsvBundle / gameIdentityKey / canonicalResultsFilename /
                          planSubmissionWrites: pure logic behind the results-submission
                          pipeline (consumed by scripts/process-submission.mjs)
    submission-preview.js ← pure logic behind the pending-submission preview:
                          resolvePreviewContext (meta/query slug + ?preview=),
                          GitHub API URL builders, classifyPull, previewCsvFiles,
                          rawFileUrl (SHA-pinned), previewBannerText
assets/
  tutorial-pack.pdf     ← bundled pack the tutorial sandbox loads
  sample_txt_pack.txt   ← full 100-slot .txt pack; fixture for tests/text-pack.test.js
scripts/                ← helpers; run from anywhere (paths use __file__)
  serve.py is at root   ← local dev server (port 8000); also /proxy/ for consensustrivia.com
  scrape_packs.py       ← regenerates ui/pack-browser.js's PACK_CATALOG
  generate_fake_tournament.py  ← writes a round-robin into tournaments/<slug>/results/
  update_manifests.py          ← rewrites manifest.json in every tournaments/*/results/ folder
  generate-golden.mjs          ← Node: regenerates tests/fixtures/golden/*.json (the PDF
                                  parse-regression fixtures) — rerun ONLY when a parse-output
                                  change is intended, and review the JSON diff
  process-submission.mjs       ← Node (not Python): drives the results-submission Action;
                                  imports src/util modules directly ("type": "module")
workers/
  pack-proxy/           ← Cloudflare Worker: CORS relay for consensustrivia.com packs
                          (worker.js + wrangler.toml + README.md with deploy steps and
                          the security model); its deployed URL is PACK_PROXY_BASE in
                          src/ui/pack-browser.js
.github/
  ISSUE_TEMPLATE/
    submit-results.yml  ← public intake form for tournament results CSVs
  workflows/
    update-manifest.yml    ← auto-regenerates manifests on push (see below)
    process-submission.yml ← issue-form submission → validated PR (see below)
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
  - `consensus-state-v1`             — saved scorekeeper game (game/persistence.js).
    Restored on load by main.js's loadState(), which always lands on the
    setup screen: re-entering the game is the explicit **Resume Game**
    button (shown only when the restored state has actual progress —
    `hasGameInProgress()` in state.js), **Start Game** confirm-warns
    before discarding such progress, and **Clear saved game** (shown only
    when a snapshot exists) wipes both keys and reloads.
  - `consensus-stats-pdf-v1`         — saved PDF bytes (game/persistence.js). Cleared on `.docx` upload via `clearSavedPdfBytes()` so the inline viewer doesn't try to render a stale PDF from the previous pack.
  - `consensus-roster-mode-v1`       — 'custom' (default) or 'preset'; legacy 'tournament' is migrated to 'preset' on read (ui/setup.js)
  - `consensus-tournament-slug-v1`   — which tournament (built-in or custom) drives the preset team-name dropdown (ui/setup.js)
  - `consensus-custom-tournaments-v1` — user-created tournaments-with-rosters (ui/custom-tournaments.js)
- **Multiple pages share modules**, so anything imported by `stats-main.js`
  or `tournaments-main.js` must not assume scorekeeper-only DOM exists.
  `tournament-stats.js`, `submission-links.js`, the util modules, and
  `roster-presets.js` are page-agnostic; everything else in `ui/`
  (setup.js, game.js, pdf-viewer.js, etc.) is index.html-only.

## Tournament Mode toggle

The Team Rosters section header carries a toggle labeled **"Tournament
Mode"** with a pill switch that reads ON or OFF, plus a tournament-picker
dropdown that appears alongside ON:

- **Tournament Mode: OFF** (default) — team-name field is a free-text
  `<input>`. Rosters are built manually. The tournament picker is hidden.
- **Tournament Mode: ON** — team-name field is a `<select>` populated
  from the chosen tournament's `rosters`. The picker (`Rosters from
  <select>`) lists ONLY the user's own tournaments (created via the
  Manage button — see below); the built-in `TOURNAMENTS` registry never
  appears here. With no tournaments yet, the picker is disabled and reads
  "None yet — use Manage". Changing the picker clears the current teams
  and repopulates the dropdowns from the newly chosen tournament. Adding
  a player offers an autocomplete `<datalist>` of the selected
  tournament's players (it repopulates whenever the picker changes).

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

### Custom tournaments (roster manager)

A **Manage** button next to the tournament picker (visible only in preset
mode) opens the "My tournaments" modal (`ui/roster-manager.js`): create,
edit, delete, export, and import user-defined tournament roster sets.
They're stored in `consensus-custom-tournaments-v1`
(`ui/custom-tournaments.js`); the picker is populated from
`loadCustomTournaments()` alone. Key facts:

- The editor is one textarea holding the plain-text roster format
  (`util/roster-text.js`): first line `Tournament: <name>`, then
  blank-line-separated team blocks (team name, then one player per
  line). Export writes the same format to `<slug>.rosters.txt`, so
  export → import round-trips.
- Slugs are auto-generated (`generateSlug`: kebab-case + `-2`/`-3` on
  collision vs built-ins and customs) and stay stable across renames —
  the slug is the identity behind `consensus-tournament-slug-v1`.
- After any create/edit/delete the manager calls setup.js's
  `refreshTournamentPicker({ mutatedSlug })`, which rebuilds the picker,
  re-applies the selected tournament if it was the one edited, and falls
  back to the first remaining tournament — or to none — (clearing teams
  only in preset mode) if the selected one was deleted.
- Custom tournaments never appear on the public stats hub or stats
  pages — `tournaments-main.js` / `stats-main.js` import the built-in
  registry directly, and custom entries have no `results/` folder.

## Packet parsing — one core, thin adapters, structured diagnostics

Every upload format funnels through the **one** parsing core,
`parseQuestions(doc)` in `src/parser/questions.js`. The core consumes a
**RichDoc** (`src/parser/rich-doc.js`): a flat list of lines, each with
plain text, rich `{ text, bold }` runs, an `isBold` flag (drives category
detection), and provenance (`page`/`y` for PDFs, `lineNo` for .txt). It
returns `{ questions, issues }` — parsing is *lenient* (a rough pack
still loads and plays) but every silent failure point emits a structured
issue instead of vanishing.

Besides `categoryInstructions` (prose between a bold category title and
its first question), the core captures **reveal notes**: a standalone
fully-parenthesized line following a question's answer — e.g. a Mystery
set's "(The theme was Alfred Hitchcock films.)" — lands in that
question's `categoryReveal` (and is truncated out of the answer text,
where it would otherwise bleed). The scorekeeper shows it under the
answer in the question panel (`#q-reveal`). Each adapter routes such
lines to the core: docx emits parenthesized stray paragraphs instead of
warning `docx-stray-text`, and the .txt classifier tags them `reveal` so
they aren't mistaken for a category title.

The file picker (`#pdf-input`, `accept=".pdf,.zip,.docx,.txt"`)
dispatches in `src/main.js` by extension to a format **adapter**:

- **`.pdf`** → `parsePdf` (`loader.js`) → `extractRichDocFromPdf`
  (`parser/pdf-text.js`). pdf.js text items are re-sorted spatially,
  grouped into lines, and bold is inferred as the second-most-used font.
  Question `pageNum`/`yPos` drive the inline viewer's scroll-to-question.
  `state.pdfBytes` is saved so the viewer can render pages. **PDF packs
  from consensustrivia.com are the most important input** — any change
  near the core or pdf adapter must keep `tests/golden-pdf.test.js`
  green (byte-exact fixtures for two real packs; regenerate deliberately
  with `node scripts/generate-golden.mjs`).
- **`.zip`** → `processZipBuffer`. A zip may hold any mix of `.pdf`,
  `.docx`, and `.txt` packs — `zipEntryFormat()` routes each entry to
  its adapter (and drops folders / `__MACOSX` junk). The dropdown gets
  one entry per pack; the first auto-loads, and the rest parse in the
  background so each dropdown entry shows a per-pack verdict
  ("Pack 3.pdf — 2 warnings"). Cached parses are reused on selection
  (PDF bytes are re-copied so pdf.js can't detach the cached entry); a
  new upload abandons the old annotation loop (generation counter).
- **`.docx`** → `parseDocx` → `parseDocxBuffer`
  (`parser/docx-questions.js`). Docx packets have no question numbers,
  so the adapter *transpiles* paragraphs into canonical numbered lines:
  sequential numbers, `A:` answer lines, bold category headers, and
  streak spans encoded as number gaps. Each streak's cap comes from
  `inferStreakCap(prompt, answerCount)` — a numeric prompt cap ("up to
  all N") beats the raw answer count; capless prompts ("up to every…")
  are standard and just use the answer count. Streak answers are worth
  half points, so slots are allocated from the pack's *cumulative* cap
  total (`ceil(cum / 2)` minus slots already allocated) — two odd caps
  share a slot instead of each rounding up. The core then handles
  everything else
  (jackpot propagation, splits naming, answerHtml) exactly as for PDFs.
- **`.txt`** → `parseTextFile` → `parseTextPack`
  (`parser/text-pack.js`). This is the **authored format**, so its
  adapter is strict: it classifies every line and reports
  precise, line-numbered issues (`txt-question-without-answer`,
  `txt-orphan-answer`, `txt-number-regression`,
  `txt-suspected-category`). `assets/sample_txt_pack.txt` must parse
  with ZERO issues (canary test in `tests/text-pack.test.js`) — if it
  doesn't, the prompt spec and the parser have drifted apart.

All paths land in loader.js's single `applyParseResult()`: the >=10
question acceptance gate, the status line (with issue count), writing
`state.parseIssues`, rendering the parse report, and persistence. Thrown
errors become a single `exception` issue so the report is never stale.
Non-PDF paths clear `state.pdfBytes` + `clearSavedPdfBytes()` (no stale
PDF on reload) and instead set `state.packDoc` — the pack's RichDoc —
which the pack viewer (`ui/pdf-viewer.js`) renders as text: the inline
panel auto-follows the current question by its `N.` line, and the
"Expand" overlay shows the whole pack. The controls-bar toggle reads
Hide Pack / Show Pack and works for every format. `packDoc` rides in
the `consensus-state-v1` snapshot so text packs survive a reload.

### Parse diagnostics

`src/parser/diagnostics.js` is pure and DOM-free. Issue shape:
`{ severity: 'error'|'warn', code, message, slot?, slots?: [a,b],
lineNo?, snippet? }`. The core emits issues at its failure points
(`duplicate-number`, `unparsed-answer`, `jackpot-unresolved`,
`empty-question`, `out-of-range-number`); adapters add format-specific
ones (`pdf-no-bold-font`, `txt-*`, `docx-*`); `analyzeQuestions()` adds
whole-pack checks after any parse (`too-few-questions`,
`slot-count-mismatch`, `numbering-gap`, `no-categories`,
`streak-span-suspicious`, `single-answer-streak`).

Issues live in `state.parseIssues` (persisted inside
`consensus-state-v1`) and surface in three places:

1. **Setup screen**: `ui/parse-report.js` renders the expandable
   "Suspected parsing issues" panel under `#pdf-status`.
2. **In-game**: sidebar slot buttons get a ⚠ flag
   (`issueSlotSet(state.parseIssues)`) and `#q-parse-warning` in the
   question panel explains the current slot's issues.
3. **Zip dropdown**: per-pack error/warning counts (see above).

All paths produce identical-shape question records, so everything
downstream (`padQuestionsToSlots`, `startGame`, `rebuildStreakGroups`,
scoring, CSV export) doesn't know or care which upload path produced
them.

## Adding a new tournament

The site hosts one folder per tournament under `tournaments/`. The
results-submission pipeline (see below) creates all of this
automatically when someone submits games under a new slug, so the manual
runbook is only needed for tournaments added outside that flow:

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
   automatically if present (`stats-main.js` HEAD-probes for the file;
   never hardcode the link in the page shell).

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
`scripts/generate_fake_tournament.py` writes a demo round-robin into
`tournaments/fake-round-robin-2026/results/` (plus that folder's
manifest) for local experimentation — that folder and slug are not
checked in and not listed in `TOURNAMENTS`, so nothing publishes it.

### Results-submission pipeline

Scorers publish games themselves instead of sending CSVs to the
maintainer. The intake is the "Submit game results" issue form
(`.github/ISSUE_TEMPLATE/submit-results.yml`): a tournament-slug input, a
paste-the-CSV textarea (`render: text`, so GitHub fences it), and an
attachments box for dragging in exported `.csv` files. Every
per-tournament stats page renders a **Submit game results →** link
(injected by `stats-main.js` via `ui/submission-links.js`, so
pipeline-generated pages get it with no per-page HTML) that opens the
form with that tournament's slug prefilled; the scorer pastes or attaches
the CSV(s) from the scorekeeper's **Export CSV** button. The stats hub
also renders a **Create its stats page →** link — the same form with no
slug prefilled — since submitting games under a fresh slug is how a new
tournament gets created (see below).
(The submit button originally lived in the scorekeeper's controls bar and
prefilled the CSV through the URL — it moved to the stats pages so
submitting sits next to where results are published, and CSV-in-URL
prefill kept hitting GitHub's ~6.5k-char 414 limit anyway.)

`process-submission.yml` runs on issues labeled `results-submission`
(opened *and* edited — a rejected submission is fixed by editing the
issue, which force-updates the same `submission/issue-<N>` branch/PR).
It runs `scripts/process-submission.mjs`, which:

1. parses the form body (field sections, fence-stripping, attachment
   URLs — both `user-attachments/files` and legacy `/files/` links),
2. splits pasted text + attachments into individual games
   (`splitCsvBundle` — several exports pasted back-to-back are fine),
3. validates: slug well-formed, each game parseable with both
   teams + players (team names are deliberately *not* checked against
   registry rosters — subs happen, and the maintainer reviews the PR),
4. writes into `tournaments/<slug>/results/` via `planSubmissionWrites`.

**A slug that isn't in `TOURNAMENTS` creates the tournament** (community
tournaments don't need a maintainer code change): the script appends a
registry entry to `src/ui/roster-presets.js` (name/description from the
form's optional fields, rosters derived from the submitted games' own
team/player rows via `buildRostersFromGames`) and generates
`tournaments/<slug>/index.html` by retargeting the first built-in
tournament's page. The entry is serialized with `JSON.stringify`
(`buildTournamentEntry`), which is what keeps untrusted names from
injecting code into a file every visitor executes; the slug itself is
gated by `isValidTournamentSlug` (strict kebab-case), which is also the
path-traversal guard. All of it lands in the same reviewable PR.

**Game identity is content, not filename**: export filenames embed a
timestamp, so a re-exported correction arrives under a new name. Games
are keyed on (packet, unordered team pair); a submission matching an
already-published game *overwrites that file in place* (keeping its
name), otherwise it lands under a timestamp-free canonical name
(`<pack> - <A> vs <B>.csv`, `-2`/`-3` on collision). This is what makes
bulk drops, mid-tournament trickle, and stat corrections all converge to
one file per game. The pure logic lives in `src/util/submission.js`
(tested in `tests/submission.test.js`); the workflow turns the resulting
working-tree diff into a PR (`Closes #N`), so publishing is always a
maintainer-reviewed merge. Manifests are untouched here — the existing
auto-manifest workflow regenerates them after the merge.

### Pending-submission preview

Submitters see their stats **before the maintainer merges** — no extra
hosting, no auto-publish. The submission workflow's issue comment links to
`tournaments/preview.html?slug=<slug>&preview=<issue-number>`; the same
`?preview=` param also works on any per-tournament page. In preview mode
the viewer loads the published manifest as usual, then overlays the
unmerged games client-side (`loadPreview` in `ui/tournament-stats.js`,
pure logic in `util/submission-preview.js`):

1. resolve the `submission/issue-<N>` branch's PR via the GitHub REST API
   (CORS-enabled, unauthenticated — well under the 60 req/hr limit),
2. list the PR's changed files, keep CSVs directly under
   `tournaments/<slug>/results/` (drops the roster-presets.js /
   index.html changes a new-tournament PR carries),
3. fetch each from `raw.githubusercontent.com` **pinned to the head SHA**
   (branch-name raw URLs sit behind a ~5-minute CDN cache; SHA-pinned
   ones are immutable, so an edited submission previews correctly),
4. upsert by filename — the pipeline's content-identity means a
   correction previews as a replacement, not a duplicate.

A persistent banner (`#ts-preview-banner`, outside `#ts-content` so view
navigation can't wipe it) always states what's being previewed, and says
so when the PR turns out to be merged/closed/missing or the API is
rate-limited — the page then just shows published stats. Guardrails: a
query-string slug only counts if it passes `isValidTournamentSlug`
(same path-traversal guard as the pipeline), and `?preview=` must be a
bare integer. Review stays the publish gate — preview is opt-in via URL
and clearly labeled, never the canonical page.

### Hosting

The repo lives at `consensus-scorekeeper/consensus-scorekeeper.github.io`
(transferred from `denisfliu/consensus-scorekeeper` in July 2026), so
GitHub Pages serves it at the org root: https://consensus-scorekeeper.github.io/.
Keep **all URLs relative** — the site must also work under a subpath
(local `serve.py`, any future mirror). The submit-results link targets
the canonical repo explicitly (`SUBMISSIONS_REPO` in
`util/submit-results.js`), never `location.href`, so copies of the site
still file submissions in the right place.

## Tests

```
npm install         # one-time: installs vitest + happy-dom
npm test            # runs all tests once
npm run test:watch  # watch mode
```

Tests live in `tests/*.test.js`. They import from `../src/main.js` (which
re-exports the public surface) so a future module split inside `src/` is
transparent to tests. Notable test files:

- `golden-pdf.test.js`             — THE PDF-regression tripwire: parses two real packs
                                     (via the pdfjs-dist devDependency, pinned to the CDN
                                     version) and diffs byte-exactly against
                                     `tests/fixtures/golden/*.json`; regenerate only
                                     deliberately with `node scripts/generate-golden.mjs`
- `parse-questions.test.js`        — synthetic RichDoc input → parsed questions
- `diagnostics.test.js`            — analyzeQuestions checks, core issue emission, helpers
- `docx-questions.test.js`         — inferStreakCap + streak slot allocation + synthetic-paragraph transpiler
                                     cases + a file-gated suite over a real local packet
- `parse-report.test.js`           — the suspected-parsing-issues panel DOM
- `state-mutations.test.js`        — reducer correctness
- `export-csv.test.js`             — CSV layout snapshot (keep multi-section format intact)
- `parse-results-csv.test.js`      — round-trip of the CSV exporter
- `tournament-aggregate.test.js`   — standings sort, leaderboard, per-team / per-player
- `tournament-fixtures.test.js`    — runs every CSV in `tournaments/*/results/`
                                     through parse + aggregate, plus asserts each manifest
                                     stays in sync with its folder
- `text-pack.test.js`              — .txt pack parsing incl. the ZERO-issue canary on
                                     `assets/sample_txt_pack.txt` and the line-numbered
                                     txt-* issue cases
- `roster-text.test.js`            — plain-text roster format: parse/serialize round-trip,
                                     error rules, slugifyName
- `custom-tournaments.test.js`     — localStorage CRUD, slug collisions, merged registry
- `roster-manager.test.js`         — picker merge + delete/edit fallbacks + modal flows
                                     through the real data-action dispatcher
- `submission.test.js`             — results-submission planning: bundle splitting,
                                     content-based game identity, replace-vs-add
- `submit-results.test.js`         — submitResultsUrl targets the canonical repo's
                                     issue form with the slug prefilled
- `submission-preview.test.js`     — pending-submission preview logic: context
                                     resolution (meta vs ?slug=, validation), API URL
                                     builders, PR classification, changed-file
                                     filtering, banner copy

If you add stats functionality, add fixtures + assertions there so the
manifest can't silently drift.

## Regenerating the pack catalog

`PACK_CATALOG` lives in `src/ui/pack-browser.js` and drives the
consensustrivia.com half of the "browse packs" UI. Each entry encodes the
level, season, tournament name, URL slug (`dir`), file-name prefix, and
number of packs. The site grows over time — championships in particular
accumulate packs past the original count of 10 — so the catalog needs
occasional refreshing.

The scraper only touches consensustrivia.com. `GRADWRITE_CATALOG` (same
file) is the hand-maintained list of gradwritetrivia.org tournaments — a
deliberately separate const so pasting fresh scraper output over
`PACK_CATALOG` can't wipe it. Update it by hand against
<https://gradwritetrivia.org/Resources/Packs> (URL scheme:
`Resources/Packs/T<n>/<filePrefix>-Pack-<n>.pdf` + `-All-Packs.zip`;
non-numbered extras like `XL1` go in `extraPacks`).

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

## Pack downloads (CORS relay)

consensustrivia.com serves its packs with **no CORS header**, so no
deployment of the site can `fetch()` them directly — every consensus
download goes through a relay. (gradwritetrivia.org sends
`Access-Control-Allow-Origin: *`, so `GRADWRITE_CATALOG` entries carry
`directCors: true` and are fetched directly, with the relay chain as
their fallback.) `fetchWithFallback` in `src/ui/pack-browser.js` walks a
chain of attempts in order:

1. `serve.py`'s `/proxy/` (local dev only),
2. **our Cloudflare Worker relay** — `PACK_PROXY_BASE`, source in
   `workers/pack-proxy/`; this is the reliable path in production,
3. free public CORS proxies (legacy fallback; rate-limited, often down),
4. a manual "download it yourself, then drop it in the upload box" link,
   so pack browsing degrades to plain downloads instead of breaking.

Deploy steps and the Worker's security model (upstream host + path
allowlists, Origin/Referer soft gate, free-plan 100k req/day hard cap —
do **not** enable Workers Paid) live in `workers/pack-proxy/README.md`.
If the Worker is ever redeployed under a new URL, update
`PACK_PROXY_BASE` in `src/ui/pack-browser.js`; setting it to `''`
disables that hop without breaking the chain.
