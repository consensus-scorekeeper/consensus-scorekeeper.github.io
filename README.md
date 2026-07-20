# consensus-scorekeeper

Scorekeeper and stats viewer for [Consensus](https://consensustrivia.com/) trivia tournaments. It runs in the browser against static files, so any HTTP server (or GitHub Pages) is enough to host it.

![Scorekeeper screen mid-game. The question sidebar runs down the left, the scoreboard sits across the top, the current question and packet PDF share the middle row, and two team player panels are at the bottom.](docs/screenshots/scorekeeper-game.png)

## Pages

The repo has five entry points.

`index.html` is the scorekeeper. You upload a packet — `.pdf`, a `.zip` of PDFs, a `.docx`, or a plain-text `.txt` — or pick one from the in-app browser of consensustrivia.com, set up rosters, and run the game. PDF packs get an inline PDF viewer for cross-checking; the text-derived formats (`.docx`/`.txt`) are text-only (no viewer). Most of the live scoring is keyboard-driven. "Export CSV" at the end writes one row per player. There's also a Pop Out button that opens a dark, presentation-style scoreboard in a separate window for projecting to players or spectators.

Progress is saved in the browser, and a refresh always lands back on the setup screen: **Resume Game** returns to the game in progress, **Start Game** warns before discarding one, and **Clear saved game** wipes the saved session.

![Setup screen with Tournament Mode switched on. Team A has a preset roster loaded; Team B's dropdown still says "Pick a team".](docs/screenshots/scorekeeper-setup.png)

![Pop-out scoreboard window: dark background with both team names and large scores side-by-side, the current question number underneath, and the category line below that.](docs/screenshots/scorekeeper-popout.png)

`player.html` is the phone page for buzzer rooms: players join with a 4-letter room code and get a full-screen buzz button, the live scoreboard, and past questions (see "Phone buzzers" below).

`tournaments/` is a hub page that lists every tournament hosted on the site, with a search box if the list grows. It also links to a "Create its stats page" form for anyone running their own tournament — submitting game CSVs under a fresh slug creates the tournament's page automatically, no code change needed.

![Tournament hub page with a search box at the top and one tournament card for Stanford Consensus 2026 below it.](docs/screenshots/stats-hub.png)

`tournaments/<slug>/` is one tournament's stats page. It reads the CSV exports from `results/manifest.json` in the same folder and shows standings, an individual leaderboard, per-team and per-player drill-downs, and a per-game breakdown. Each stats page also has a "Submit game results" link — a GitHub form where anyone can paste or attach exported CSVs to publish games to that page (see "Running a tournament" below).

![Stanford Consensus 2026 stats page. A summary card on top, the team standings table below it, and the individual leaderboard below that.](docs/screenshots/stats-standings.png)

![Per-game drill-down: two side-by-side tables, one for each team, listing every player's points in a single match.](docs/screenshots/stats-game-breakdown.png)

`stats.html` is left over from before the hub existed; it just redirects to `tournaments/`.

## Running it

```
python serve.py
```

That starts a dev server on port 8000. The scorekeeper is at /, the hub at /tournaments/. The server also proxies `/proxy/` requests to consensustrivia.com, which is what lets the in-app pack browser work without CORS issues. On the live (GitHub Pages) site the same job is done by a small Cloudflare Worker (`workers/pack-proxy/`); if every relay is unavailable the pack browser falls back to a plain download-it-yourself link.

## Running a tournament

The intended workflow during a multi-room tournament:

1. Each room scores its game in `index.html` and clicks Export CSV at the end.
2. Someone opens the tournament's stats page and clicks **Submit game results**. That's a GitHub issue form with the tournament slug prefilled — paste the CSV(s) into the text box or drag the files into the attachments box. A bot validates the submission within a minute or two and opens a pull request; a maintainer merging it publishes the games. Re-submitting a game (same packet, same two teams) replaces the earlier version instead of duplicating it.
3. After the merge, an Action regenerates that folder's `manifest.json`. The next visit to the tournament's stats page picks up the new games.

Maintainers can also skip the form and drop CSVs straight into `tournaments/<slug>/results/` — the manifest Action runs on any push that touches those folders. If you're testing locally without pushing, `scripts/update_manifests.py` does the same thing by hand.

New tournaments don't need a code change: submitting results under a fresh slug creates the registry entry and stats page automatically in the same pull request. To add one by hand instead, append an entry to `TOURNAMENTS` in `src/ui/roster-presets.js`, then copy `tournaments/stanford-consensus-2026/index.html` into a new folder named after the slug and change the one `<meta name="tournament-slug">` tag inside. Drop CSVs into the new `results/` folder and the hub starts showing it.

## Phone buzzers

Open **📱 Buzzers** in the scoreboard and click **Create room** — you get a 4-letter room code and a player link to share. Everyone who opens the link on their phone gets a full-screen buzz button plus the live scoreboard and a browsable list of past questions (with answers, once the moderator has moved on). It works on a computer too — **Space** buzzes. A small toggle in the top bar picks whether your buzz fires the instant you press or when you release. First buzz wins — with latency equalization: the server measures each player's ping and adjudicates near-simultaneous buzzes by estimated press time, so being far from the moderator doesn't decide races. The moderator sees who buzzed, reads the highlighted player, and presses **Space** to award the points (or **Esc** to dismiss and re-open the buzzers — normal scoring keys keep working too). If a phone joins under a name that isn't on a roster, click that player's row once to link them up.

There's also a **spectator link** — the same page without the buzz button — which is the remote version of the Pop Out scoreboard, and a **Hold buzzers** checkbox for when you need the room quiet. Jailbreak lockouts and streak scoring behave the way they do at the table: locked players' buzzes are ignored (buzzers re-open automatically), and streaks stay open for both teams.

Rooms run on a free shared Cloudflare Worker and expire on their own after 12 hours of inactivity. Nothing about your game leaves your browser except the scoreboard the players see. Self-hosters can deploy their own room server (it ships with [qb-moderator](https://github.com/qbsuite/qb-moderator)) and point the app at it with `?roomserver=`.

## Tournament Mode

There's a "Tournament Mode" toggle in the Team Rosters section of the setup screen. When it's off (the default), you type team names freely. When it's on, the team-name fields become dropdowns of preset rosters from the chosen tournament; a second dropdown next to the toggle lets you pick which of your tournaments' rosters to load, and a Manage button creates, edits, imports, and exports them (they're saved in the browser).

In Tournament Mode the add-player autocomplete lists the selected tournament's players (mostly to keep subs' names from being misspelled). With the toggle off the autocomplete is empty — typing your own roster shouldn't get nudged toward names from tournaments you aren't using.

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

## Contributing

Bug reports and feature ideas are welcome — [open an issue](https://github.com/consensus-scorekeeper/consensus-scorekeeper.github.io/issues). Pull requests are welcome too; see [CONTRIBUTING.md](CONTRIBUTING.md) for how to get a dev setup running (there's no build step) and where things live. Publishing tournament results never requires touching code — that's what the submission form above is for.

## Internal notes

`CLAUDE.md` has the architecture notes that aren't obvious from reading the code: state ownership, localStorage key conventions, what's allowed where between modules, and the runbook for adding a tournament. Worth reading before refactoring anything substantial.
