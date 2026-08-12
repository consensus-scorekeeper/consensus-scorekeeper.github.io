# submit-relay — Cloudflare Worker

Files "Submit game results" (and game-removal) GitHub issues on behalf of
people who don't have a GitHub account, straight from the site's in-page
form. Everything downstream is the existing results-submission pipeline —
this Worker is only a second front door to it. Trust model, auto-publish
rules, and the publishing-key design live in **docs/submission-relay.md**;
this README is the deploy runbook.

## What it needs

| Thing | Why |
|---|---|
| KV namespace `KEYS` | publishing-key hashes (`slug:<slug>`) + rate counters |
| GitHub credential | to create issues in the repo (issues permission ONLY) |
| `ADMIN_SECRET` | gates `/admin/activate`, `/admin/delete-key`, `/admin/rotate` |
| `TURNSTILE_SECRET` (optional) | bot-check on submissions once enabled |

## Deploy

From this folder:

```
npx wrangler login
npx wrangler kv namespace create KEYS     # once — paste the id into wrangler.toml
npx wrangler deploy                        # prints https://consensus-submit-relay.<sub>.workers.dev
npx wrangler secret put ADMIN_SECRET       # any long random string; also goes in the
                                           # repo's Actions secrets as RELAY_ADMIN_SECRET
```

Put the printed URL in `SUBMIT_RELAY_BASE` (`src/util/submit-relay.js`) and
in the `RELAY_URL` repo Actions variable. Leaving `SUBMIT_RELAY_BASE` empty
disables the in-app form entirely (the site falls back to the GitHub form),
so nothing breaks while this is half-deployed.

## GitHub credential — two options

**Option A (recommended): GitHub App.** No expiry, clean bot identity —
and the pipeline's auto-publish "author wall" checks for the App's
`[bot]` login.

1. Org settings → Developer settings → GitHub Apps → **New GitHub App**.
   Name: `consensus-submit-relay` (the name determines the bot login —
   `consensus-submit-relay[bot]` — which must match `RELAY_BOT_LOGIN` in
   `process-submission.yml` / `process-removal.yml`). Homepage: the site
   URL. Uncheck Webhook. Permissions: **Issues: Read and write** — nothing
   else. "Only on this account".
2. Create the app → note the **App ID** → **Generate a private key**
   (downloads a `.pem`).
3. Install the app on the org, repository access: **only**
   `consensus-scorekeeper.github.io`. The installation id is the number in
   the installation page URL.
4. The `.pem` is PKCS#1; WebCrypto needs PKCS#8. Convert, then store:
   ```
   openssl pkcs8 -topk8 -nocrypt -in app.pem -out app-pkcs8.pem
   npx wrangler secret put GITHUB_APP_KEY < app-pkcs8.pem
   ```
5. Fill `GITHUB_APP_ID` and `GITHUB_INSTALLATION_ID` in `wrangler.toml`
   and redeploy.

**Option B (quick start): fine-grained PAT.** Settings → Developer
settings → Fine-grained tokens: repository access = only this repo,
permissions = Issues: Read and write. `npx wrangler secret put
GITHUB_TOKEN`. Works immediately, but expires (max 1 year), files issues
under your own account, and — important — **auto-publish stays off**: the
pipeline's author wall won't match, so every submission just takes
today's manual-review path. Fine for smoke-testing the flow.

## Smoke test

```
curl -s https://<worker>/submit -H 'Content-Type: application/json' -d '{
  "slug": "stanford-consensus-2026",
  "csv": "<paste an exported CSV here, JSON-escaped>"
}'
```

Expected: `{"issue":N,...,"verified":false}`, a new issue in the repo
within a second, and the bot's validation comment + PR within a minute or
two — the pipeline treats it exactly like a hand-filed form issue.

Mint a key for any slug and hand it to its TD — pre-approving a slug
before its tournament exists works too (and reserves it):

```
node scripts/mint_key.mjs <slug>        # from the repo root (see the script
                                        # header for where the secret lives)
```

or the raw call it wraps:

```
curl -s https://<worker>/admin/rotate -H "Authorization: Bearer $ADMIN_SECRET" \
  -H 'Content-Type: application/json' -d '{"slug":"stanford-consensus-2026"}'
```

## Turnstile (optional, recommended once public)

Cloudflare dash → Turnstile → add the site (`consensus-scorekeeper.github.io`),
widget mode "Managed". `npx wrangler secret put TURNSTILE_SECRET`, and put
the **site key** in `TURNSTILE_SITE_KEY` (`src/util/submit-relay.js`).
With the secret unset the Worker skips the check — deploys don't have to
be lock-step.

## Security model (short form — the long form is docs/submission-relay.md)

- The credential here can **only file issues**. Publishing is still the
  pipeline: validation → PR → merge behind the author/stamp/diff walls.
  A fully compromised Worker ⇒ spam issues, nothing more.
- Publishing keys are stored **only as SHA-256 hashes**; a KV leak reveals
  no keys. A leaked key is scoped to one tournament's results folder and
  is rotated with one `/admin/rotate` call.
- Submissions must parse as real results CSVs before any issue is filed —
  garbage is rejected at the door.
- Rate caps: 50/day per IP, 300/day per slug, 300 KB per request, plus the
  free plan's 100k req/day hard cap. Do **not** enable Workers Paid — the
  Worker can error out at the cap but can never run up a bill.
- `ADMIN_SECRET` grants key administration (mint/activate/delete) — it
  never touches GitHub. It lives here and in the repo's Actions secrets
  (`RELAY_ADMIN_SECRET`) so workflows can activate/delete keys.
