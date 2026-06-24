# consensus-scorekeeper

Scorekeeper and stats viewer for [Consensus](https://consensustrivia.com/) trivia tournaments. It runs in the browser against static files, so any HTTP server (or GitHub Pages) is enough to host it.

![Scorekeeper screen mid-game. The question sidebar runs down the left, the scoreboard sits across the top, the current question and packet PDF share the middle row, and two team player panels are at the bottom.](docs/screenshots/scorekeeper-game.png)

## Pages

The repo has four entry points.

`index.html` is the scorekeeper. You upload a packet — `.pdf`, a `.zip` of PDFs, a `.docx`, or a plain-text `.txt` — or pick one from the in-app browser of consensustrivia.com, set up rosters, and run the game. PDF packs get an inline PDF viewer for cross-checking; the text-derived formats (`.docx`/`.txt`) are text-only (no viewer). A "Format pack" button on the setup screen helps you convert arbitrary raw questions into the `.txt` format by copying a prefilled LLM prompt to your clipboard. Most of the live scoring is keyboard-driven. "Export CSV" at the end writes one row per player. There's also a Pop Out button that opens a dark, presentation-style scoreboard in a separate window for projecting to players or spectators.

![Setup screen with "Tournament rosters" switched on. Team A has the Wookiee roster loaded; Team B's dropdown still says "Pick a team".](docs/screenshots/scorekeeper-setup.png)

![Pop-out scoreboard window: dark background with both team names and large scores side-by-side, the current question number underneath, and the category line below that.](docs/screenshots/scorekeeper-popout.png)

`tournaments/` is a hub page that lists every tournament hosted on the site, with a search box if the list grows.

![Tournament hub page with a search box at the top and one tournament card for Stanford Consensus 2026 below it.](docs/screenshots/stats-hub.png)

`tournaments/<slug>/` is one tournament's stats page. It reads the CSV exports from `results/manifest.json` in the same folder and shows standings, an individual leaderboard, per-team and per-player drill-downs, and a per-game breakdown.

![Stanford Consensus 2026 stats page. A summary card on top, the team standings table below it, and the individual leaderboard below that.](docs/screenshots/stats-standings.png)

![Per-game drill-down: two side-by-side tables, one for each team, listing every player's points in a single match.](docs/screenshots/stats-game-breakdown.png)

`stats.html` is left over from before the hub existed; it just redirects to `tournaments/`.

## Running it

```
python serve.py
```

That starts a dev server on port 8000. The scorekeeper is at /, the hub at /tournaments/. The server also proxies `/proxy/` requests to consensustrivia.com, which is what lets the in-app pack browser work without CORS issues.

## Running a tournament

The intended workflow during a multi-room tournament:

1. Each room scores its game in `index.html` and clicks Export CSV at the end.
2. The CSVs get dropped into `tournaments/<slug>/results/`.
3. After pushing to GitHub, an Action regenerates that folder's `manifest.json`. The next visit to the tournament's stats page picks up the new games.

If you're testing locally without pushing, `scripts/update_manifests.py` does the same thing by hand.

To add a new tournament, append an entry to `TOURNAMENTS` in `src/ui/roster-presets.js`, then copy `tournaments/stanford-consensus-2026/index.html` into a new folder named after the slug and change the one `<meta name="tournament-slug">` tag inside. Drop CSVs into the new `results/` folder and the hub starts showing it.

## Roster modes

There's a "Tournament rosters" toggle in the top-right of the setup screen. When it's off (the default), you type team names freely. When it's on, the team-name fields become dropdowns of preset rosters from the chosen tournament; a second dropdown next to the toggle lets you pick which tournament's rosters to load.

In preset mode the add-player autocomplete lists every player from every tournament (mostly to keep subs' names from being misspelled). In custom mode the autocomplete is empty — typing your own roster shouldn't get nudged toward names from tournaments you aren't using.

## Tutorial

The setup screen has a Tutorial button that boots a sandbox session: preset rosters, a bundled sample pack, and a 13-step walkthrough that highlights each control.

![Tutorial overlay over the scorekeeper. Most of the page is dimmed; a spotlit element shows a player panel with a tooltip explaining the scoring button.](docs/screenshots/tutorial-overlay.png)

The tutorial doesn't touch your saved game. Closing it reloads the page and restores whatever real session you had before.

## Tests

```
npm install
npm test
```

About 150 tests via Vitest + happy-dom. They cover the PDF question parser, the `.docx` parser (including the streak-slot inference heuristic), the `.txt` pack parser, the scoring reducers, the CSV export round-trip, the tournament aggregator, and a structural sweep over every CSV under `tournaments/*/results/`.

## Internal notes

`CLAUDE.md` has the architecture notes that aren't obvious from reading the code: state ownership, localStorage key conventions, what's allowed where between modules, and the runbook for adding a tournament. Worth reading before refactoring anything substantial.
