// The persistent "this device publishes to <slug>" chip — a deliberately
// quiet, semi-transparent pill pinned bottom-left on EVERY page
// (scorekeeper, stats pages, hub), so tournament staff always see at a
// glance which tournament their device is keyed for. Links to that
// tournament's stats page. Hidden when no stored key pins down a single
// tournament (quickPublishSlug) — it never guesses.
//
// Page-agnostic: each entry point calls renderPublishBadge with the
// relative path from ITS location to the tournaments/ folder (URLs must
// stay relative so mirrors and local dev work), plus aboveControls on
// the scorekeeper, whose bottom bar owns the default spot.

import {
  relayEnabled,
  loadPublishingKeys,
  quickPublishSlug,
} from '../util/submit-relay.js';
import { escapeHtml } from '../util/escape.js';

const LAST_SUBMIT_SLUG_KEY = 'consensus-last-submit-slug-v1';

export function renderPublishBadge({ tournamentsBase, aboveControls = false } = {}) {
  document.getElementById('publish-badge')?.remove();
  if (!relayEnabled()) return;
  let lastSlug = '';
  try { lastSlug = localStorage.getItem(LAST_SUBMIT_SLUG_KEY) || ''; } catch { /* ignore */ }
  const slug = quickPublishSlug(lastSlug, loadPublishingKeys());
  if (!slug) return;
  const badge = document.createElement('a');
  badge.id = 'publish-badge';
  if (aboveControls) badge.className = 'above-controls';
  badge.href = `${tournamentsBase}${slug}/`;
  badge.target = '_blank';
  badge.rel = 'noopener';
  badge.title = 'This device is set up to publish games to this tournament — click to open its stats page';
  badge.innerHTML = `🔑 ${escapeHtml(slug)}`;
  document.body.appendChild(badge);
}
