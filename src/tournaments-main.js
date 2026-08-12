// Entry point for tournaments/index.html — the public stats hub. Lists
// every entry in TOURNAMENTS as a clickable card linking to <slug>/
// (relative to this page), with a search box that filters by
// name/slug/description.
//
// Adding a tournament is a one-place edit: append to TOURNAMENTS in
// src/ui/roster-presets.js and the card shows up here automatically.

import { TOURNAMENTS } from './ui/roster-presets.js';
import { escapeHtml } from './util/escape.js';
import { createTournamentLink } from './ui/submission-links.js';
import { renderPublishBadge } from './ui/publish-badge.js';

// The hub lives in tournaments/ itself, so slug pages are direct children.
renderPublishBadge({ tournamentsBase: '' });

const list = document.getElementById('tournaments-list');
const search = document.getElementById('tournaments-search');

// "Create your own tournament" link — submitting game CSVs under a fresh slug
// via the GitHub form creates that tournament's stats page automatically, so
// community tournaments don't need a maintainer code change to appear here.
const searchRow = document.querySelector('.tournaments-search-row');
if (searchRow) searchRow.parentNode.insertBefore(createTournamentLink(), searchRow);

function matches(t, q) {
  if (!q) return true;
  const hay = `${t.name} ${t.slug} ${t.description || ''}`.toLowerCase();
  return hay.includes(q);
}

function render() {
  if (!list) return;
  const q = (search && search.value ? search.value : '').toLowerCase().trim();
  const items = TOURNAMENTS.filter((t) => matches(t, q));
  if (!items.length) {
    list.innerHTML = `<li class="tournaments-empty">No tournaments match "${escapeHtml(search ? search.value : '')}".</li>`;
    return;
  }
  list.innerHTML = items.map((t) => `
    <li class="tournament-card">
      <a class="tournament-card-link" href="${escapeHtml(t.slug)}/">
        <span class="tournament-card-name">${escapeHtml(t.name)}</span>
        ${t.description ? `<span class="tournament-card-desc">${escapeHtml(t.description)}</span>` : ''}
      </a>
    </li>
  `).join('');
}

if (search) search.addEventListener('input', render);
render();
