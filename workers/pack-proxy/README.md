# pack-proxy — Cloudflare Worker

A tiny CORS relay so the scorekeeper's "browse packs from consensustrivia.com"
flow can fetch packs reliably from the live (GitHub Pages) site.

## Why this exists

consensustrivia.com serves its pack PDFs with **no `Access-Control-Allow-Origin`
header**. A browser therefore refuses to let our static site read the bytes via
`fetch()`. Before this Worker the app fell back to free public CORS proxies
(codetabs/allorigins/etc.), which are rate-limited and frequently down — that
was the "extremely unreliable" download problem.

This Worker fetches the pack server-side (where same-origin policy doesn't
apply) and re-emits it with `Access-Control-Allow-Origin: *`. It **relays**
on demand — it never stores copies of anyone's content.

## Deploy (Wrangler CLI — recommended, ~3 minutes)

The dashboard's create flow gets relabeled often; the CLI is stable and
repo-tracked (`wrangler.toml` lives next to `worker.js`). From this folder:

```
npx wrangler login      # one-time; opens a browser to authorize
npx wrangler deploy      # deploys worker.js, prints the URL
```

- `login` opens Cloudflare in your browser — click **Allow**.
- The **first** `deploy` asks you to register a free `*.workers.dev` subdomain;
  pick any name. It then prints
  `https://consensus-pack-proxy.<your-subdomain>.workers.dev`.
- Put that URL in `PACK_PROXY_BASE` in `src/ui/pack-browser.js` and commit.
- Redeploy after any edit to `worker.js` with `npx wrangler deploy` again.

### Dashboard alternative

If you'd rather use the UI: <https://dash.cloudflare.com> → **Compute (Workers)**
(older accounts: **Workers & Pages**) → **Create** / **Create application** →
**Start with Hello World** → name it, **Deploy**, then **Edit code**, paste
[`worker.js`](./worker.js), **Deploy** again. The button labels move around; the
CLI above avoids that entirely.

## Is it safe to expose in a public repo? Yes — here's the model

The Worker URL is discoverable in our public source. These layers keep that from
mattering:

- **Upstream host allowlist** (`ALLOWED_HOSTS`) — the Worker will *only* fetch
  `consensustrivia.com` and `gradwritetrivia.org`. It can never be repurposed as
  a general open proxy for arbitrary sites. Worst case it's a free CDN for those
  sites' public packs. (Gradwrite serves packs with open CORS, so the browser
  normally fetches them directly; the Worker is only its fallback.)
- **Path allowlist** — only `.pdf`/`.zip` targets are relayed.
- **Origin/Referer allowlist** (`ALLOWED_ORIGINS`) — a soft gate so other
  websites can't casually embed the relay from a browser. Add a mirror's origin
  here if you serve the site elsewhere; empty the array to disable the check.
- **No billing risk** — on the **free** Workers plan you get 100,000 requests/day
  and the Worker simply returns errors once that's hit. It **cannot** run up a
  bill. Do **not** upgrade to "Workers Paid" or add usage-based billing, and this
  stays free-with-a-hard-cap forever.
- **Edge caching** — `cf.cacheEverything` caches each pack at Cloudflare's edge
  for a day, so repeat downloads are fast and barely touch consensustrivia.com.

## Graceful degradation

The app treats this Worker as the *preferred* relay but never depends on it:

1. Worker relay (this) — reliable.
2. Public CORS proxies — legacy fallback if the Worker is unset/over quota/down.
3. **Manual download link** — if every fetch path fails, the app shows a direct
   "Download it yourself, then drop it in the upload box" link, so browsing packs
   still works with zero infrastructure.

So if you ever hit the daily cap (or delete the Worker), pack browsing degrades
to plain downloads rather than breaking.
