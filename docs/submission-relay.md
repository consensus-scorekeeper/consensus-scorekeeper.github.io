# Submission relay — in-app results submission without GitHub

Design doc for the submit-relay Worker and the auto-publish flow around it.
This is the source of truth for the trust model; keep it updated if the
mechanics change.

## Problem

The results-submission pipeline (issue form → `process-submission.yml` →
validated PR → maintainer merge) works, but its front door has friction:
submitters need a GitHub account and must leave the site to file the issue,
and every publish waits on a human merge. Tournaments are run by several
room moderators (or one TD uploading everything) who just want scored games
to appear on their stats page.

## Shape of the solution

A small Cloudflare Worker (`workers/submit-relay/`) becomes a second front
door to the **unchanged** pipeline: it accepts a POST from an in-page form
(stats pages, hub, and the scorekeeper itself) and files the GitHub issue on
the submitter's behalf, rendered in exactly the issue-form markdown that
`scripts/process-submission.mjs` already parses. Everything downstream —
validation, PR, preview, manifest regeneration — is reused as-is.

Trust is per-tournament, not per-person: each tournament has one
**publishing key** (a shared secret, like a Wi-Fi password) that the TD
distributes to their moderators. A submission accompanied by the right key
is stamped "verified" by the Worker and **auto-merges** — no human in the
loop. Everything else falls back to today's manual-review path.

```
scorekeeper / stats page
        │  POST {slug, csv, key?}
        ▼
  submit-relay Worker ── verifies key against KV, validates CSVs,
        │                creates the GitHub issue (App token)
        ▼
  results-submission issue ──► process-submission.yml
        │                        ├─ verified + safe diff → auto-merge
        ▼                        └─ otherwise → PR waits for maintainer
  stats page updates
```

## The trust model

### Publishing keys

- One key per tournament slug. Format `cs_<40 hex chars>`; the Worker
  stores only `sha256(key)` in its KV namespace under `slug:<slug>` as
  `{ hash, status: 'pending' | 'active', created }`.
- **Issued at tournament creation.** When a submission arrives for a slug
  that (a) has no KV entry and (b) has no published
  `tournaments/<slug>/results/manifest.json` on the live site, the Worker
  treats it as a new tournament: it generates the key, stores the hash as
  `pending`, and returns the key **once** in the response ("save this —
  share it with your moderators"). The key activates when the
  tournament-creation PR merges (`finalize-submission.yml` calls the
  Worker's admin activate endpoint).
- Tournaments that predate this system have no key until the maintainer
  mints one and hands it to the TD: `node scripts/mint_key.mjs <slug>`
  (wraps `/admin/rotate`; secret from `RELAY_ADMIN_SECRET` or the
  git-ignored `workers/submit-relay/.admin-secret`). Minting also works
  for a slug that doesn't exist yet — that **reserves** it: the TD gets
  an active key up front, their creation submission arrives verified but
  still takes the human merge (new slugs always do), and the relay won't
  mint a competing key to whoever else submits under that slug first.
  Re-minting an existing slug's key kills the old one instantly
  (lost/leaked-key recovery).
- Keys live client-side in localStorage per slug, so each moderator device
  enters it once.

### What a key proves, and what it cannot do

Verification means: the presented key's hash matches **this slug's** stored
hash and the entry is `active`. A key is never an identity — there is no
"trusted user", so there is nothing to escalate. A Stanford key presented
against another slug fails against that slug's hash and the submission
simply drops to manual review.

### The two-wall safety line (auto-merge gate)

`process-submission.yml` auto-merges only when **all** hold:

1. **Author wall** — the issue was authored by the relay's bot account
   (`consensus-submit-relay[bot]`). Only the Worker holds that credential,
   so the "Relay verification" stamp in the body is trustworthy. A human
   pasting the stamp into a hand-made issue fails this check.
2. **Stamp** — the body carries `verified-for: <slug>` matching the
   submission's slug.
3. **Diff wall** — every file the PR actually changes lives under
   `tournaments/<slug>/results/` for that same slug. This is checked
   against the real git diff, not the form. It structurally excludes the
   dangerous case: new-tournament submissions touch
   `src/ui/roster-presets.js` (code every visitor executes) and so always
   keep a human merge — trusted key or not.

Either wall alone stops cross-tournament writes; together they also stop a
Worker bug from turning into a code-publish path. Within one tournament,
overwriting a previously published game (content identity: packet +
unordered team pair) is the intended correction flow.

Manual override: a maintainer can put the `auto-hold` label on an issue
before/while it processes to force manual review, and can revoke a key any
time (`/admin/delete-key` or `/admin/rotate`).

### GitHub credential

A GitHub App (suggested name `consensus-submit-relay`) owned by the org,
installed on this repo only, with **Issues: read/write and nothing else**.
The Worker holds its private key as a secret and mints installation tokens
(cached ~55 min). The internet-facing credential can only file issues — it
cannot push code or merge; merging is done by the workflow's own
`GITHUB_TOKEN` behind the safety line. For a quick start the Worker also
accepts a fine-grained PAT (`GITHUB_TOKEN` secret, issues-only, this repo
only) instead; prefer the App long-term (no expiry, clean bot identity —
and the author wall assumes the bot login).

## Worker API (`workers/submit-relay/`)

All endpoints are JSON POST, CORS-allowlisted to the site's origins.

- `POST /submit` — `{ slug, csv, name?, description?, notes?, key?,
  turnstileToken? }`. Validates the slug shape, size caps (256 KB), and
  that `csv` splits into ≥1 parseable game (same pure modules the pipeline
  uses, bundled by wrangler). Verifies Turnstile when configured. Files the
  issue (label `results-submission`, body via
  `src/util/relay-issue.js` so the format can't drift from the parser).
  Returns `{ issue, issueUrl, previewUrl, verified, newTournamentKey? }`.
- `POST /remove-game` — `{ slug, filename, key }`. Requires an **active**
  key match (removal has no manual-review fallback). Files a `game-removal`
  issue; `process-removal.yml` deletes the file, regenerates the manifest,
  commits, and closes the issue.
- `POST /admin/activate | /admin/delete-key | /admin/rotate` — gated by
  `Authorization: Bearer <ADMIN_SECRET>`. Activate is called by
  `finalize-submission.yml` on new-tournament merges; delete-key by the
  remove-tournament workflow; rotate mints/replaces a key for a slug and
  returns it (for pre-existing tournaments or lost keys).

Abuse controls: Turnstile (optional, recommended), origin allowlist,
payload caps, must-parse validation (garbage never becomes an issue),
per-slug and per-IP daily counters in KV, and the free-plan hard cap.
Worst case for a leaked key: wrong numbers on that one tournament's page —
revert one commit, rotate the key.

## Repo-side pieces

- `src/util/relay-issue.js` — pure: issue-body builders + the
  `### section` parser (moved out of `process-submission.mjs`) + the
  verification-stamp builder/parser + key hashing. A round-trip test pins
  the Worker↔pipeline body contract.
- `process-submission.yml` — after creating/updating the PR: if the script
  reports `verified=true`, check the diff wall, run
  `scripts/update_manifests.py` **on the branch** (so stats go live at the
  merge, and because pushes by `GITHUB_TOKEN` don't trigger
  `update-manifest.yml`), merge, and post the 🎉/close inline (same
  reason: `finalize-submission.yml` won't fire on a `GITHUB_TOKEN` merge).
- `process-removal.yml` — handles `game-removal` issues: author wall +
  stamp + filename confined to the slug's results folder → delete file,
  regen manifest, commit directly to main, comment + close.
- `remove-tournament.yml` — `workflow_dispatch(slug)`, maintainer-only by
  GitHub's own permissions. Runs `scripts/remove_tournament.mjs` (deletes
  `tournaments/<slug>/`, strips the registry entry via
  `removeTournamentEntry`), commits, and calls `/admin/delete-key`.
  **Invariant:** the KV hash must be deleted on tournament removal —
  a stale hash would let the old key publish into a future tournament
  that reuses the slug.
- `finalize-submission.yml` — on merged PRs that touched
  `roster-presets.js` (i.e. tournament creation), call `/admin/activate`
  for the slug.

## Frontend

- `src/util/submit-relay.js` — `SUBMIT_RELAY_BASE` (empty string disables
  the relay, like `PACK_PROXY_BASE`), client calls, per-slug key storage
  (`consensus-tournament-keys-v1`).
- `src/ui/submission-form.js` — in-page modal replacing the outbound
  GitHub link when the relay is enabled: slug (prefilled on stats pages),
  paste box + file input (files read client-side; the relay path never
  needs GitHub attachments), key field (auto-filled from storage),
  **client-side pre-validation** via `splitCsvBundle`/`parseResultsCsv`
  for instant feedback, and a success panel with the preview link
  (`tournaments/preview.html?slug=…&preview=<issue>`) — or "published!"
  when verified. On relay failure it falls back to the GitHub form link;
  the old path stays fully functional.
- Scorekeeper: a **Submit results** button next to Export CSV that opens
  the same modal with the current game's CSV prefilled — one click from
  final score to published stats on a device that has the key.
- Stats page: with a stored key for the slug, each game row in the
  per-game list gets **Remove this game** (posts `/remove-game`).

## Fixing mistakes (summary)

- Wrong scores → rescore, resubmit; content identity overwrites in place.
- Wrong team/packet name (identity changed → would duplicate) → remove the
  bad game from the stats page, resubmit the fixed one.
- Junk tournament → maintainer runs the Remove-tournament workflow from
  the Actions tab.
- Lost/leaked key → maintainer `/admin/rotate`.

## Deployment status (2026-08-11: LIVE)

Everything above is deployed and was verified end to end in production
with a scratch tournament (issues #14/#16/#18, PRs #15/#17): creation →
maintainer merge → key activation → **verified submission auto-published
by the workflow itself** → key-authorized game removal → Remove-tournament
workflow wiping folder + registry + KV hash.

- Worker: `https://consensus-submit-relay.denisliu10.workers.dev`
  (`SUBMIT_RELAY_BASE` in `src/util/submit-relay.js`; also the repo
  Actions variable `RELAY_URL`, with `RELAY_ADMIN_SECRET` as the
  matching secret).
- Credential: GitHub App `consensus-submit-relay` (App ID 4565633,
  installation 153080588) — Issues R/W on this repo only. Its bot login
  is what `RELAY_BOT_LOGIN` defaults to in the workflows.
- Not yet enabled: Turnstile (both sides ship the hooks; turn it on per
  workers/submit-relay/README.md if spam ever appears).

Kill switches / levers, mildest first: `auto-hold` label on an issue
(forces manual review), `scripts/mint_key.mjs` re-mint (revokes a key),
`/admin/delete-key` (removes a slug's key entirely), Remove-tournament
workflow (Actions tab), and setting `SUBMIT_RELAY_BASE = ''` (turns the
whole in-app feature off — the site falls back to the GitHub form and
behaves exactly as before this feature existed).
