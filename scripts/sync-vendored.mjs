// Refresh vendored files from their canonical sibling checkouts so
// copies can't drift (same stance as library-of-stock's build.py
// sync_vendored_js). Run via `npm run sync-vendored`. If a canonical
// checkout is missing this is a no-op for that file.
//
// NEVER edit files under src/vendor/ directly — change the canonical
// copy and re-run this script. tests/vendor-sync.test.js enforces
// byte-equality whenever the sibling checkout is present.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const VENDORED = [
  {
    vendored: 'src/vendor/room.js',
    canonical: '../qb-scorekeeper/app/room.js',
  },
];

// Only sync when run as a script — tests import VENDORED without
// wanting the write side effect.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const { vendored, canonical } of VENDORED) {
    const src = path.resolve(root, canonical);
    const dst = path.resolve(root, vendored);
    if (!existsSync(src)) {
      console.log(`skip ${vendored}: canonical checkout not found (${canonical})`);
      continue;
    }
    const want = readFileSync(src, 'utf8');
    const have = existsSync(dst) ? readFileSync(dst, 'utf8') : null;
    if (have === want) {
      console.log(`ok   ${vendored}`);
    } else {
      writeFileSync(dst, want);
      console.log(`sync ${vendored} <- ${canonical}`);
    }
  }
}
