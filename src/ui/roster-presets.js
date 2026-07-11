// Tournament registry — the stats pages' source of truth. Each tournament
// has its own rosters and slug; the slug doubles as its folder name under
// `tournaments/`. Two UI surfaces read from here:
//   1. tournaments/index.html  — the hub lists every TOURNAMENTS entry,
//                                linking to `<slug>/` (relative to the hub).
//   2. The per-tournament stats page at tournaments/<slug>/index.html
//      stamps its title from the matching entry. The page identifies
//      itself via a <meta name="tournament-slug"> tag.
//
// The scorekeeper's Tournament Mode picker deliberately does NOT read this
// registry — it lists only the user's own tournaments
// (ui/custom-tournaments.js). Registry slugs still reserve their names
// (generateSlug never shadows one).
//
// To add a new tournament:
//   1. Append a new object to TOURNAMENTS below (set slug to the desired
//      folder name).
//   2. Create tournaments/<slug>/index.html as a copy of
//      tournaments/stanford-consensus-2026/index.html, updating the
//      <meta name="tournament-slug"> content to match.
//   3. Drop the tournament's CSVs into tournaments/<slug>/results/.
//      The auto-manifest workflow regenerates manifest.json on push.

export const TOURNAMENTS = [
  {
    name: 'Stanford Consensus 2026',
    slug: 'stanford-consensus-2026',
    description: 'Round-robin held May 2026 across 8 post-secondary teams.',
    rosters: [
      { name: 'strangers on a chrain', players: ['Terry Tang', 'Richard Niu', 'Anuttam Ramji'] },
      { name: 'Oggdo Bogdo', players: ['Andrew Zeng', 'Ryan Fang'] },
      { name: 'Wookiee', players: ['Danny Han', 'Denis Liu', 'Ethan Bosita'] },
      { name: 'Varactyl', players: ['Aditya Koushik', 'Ana Corral', 'Shaphnah McKenzie'] },
      { name: 'Sarlacc', players: ['Benjamin McAvoy-Bickford', 'David Lingan', 'Michał Gerasimiuk'] },
      { name: 'ACEAMSDPP', players: ['Ankit Aggarwal', 'Ankur Aggarwal'] },
      { name: 'SF Individuals', players: ['Arjun Panickssery', 'Adam Kalinich', 'Ryan Panwar'] },
      { name: 'Dust of Snow', players: ['Lorie Au Yeung', 'Huy Lai', 'Doug Robeson'] },
    ],
  },
  {
    "name": "Test Tournament",
    "slug": "my-invitational",
    "rosters": [
      {
        "name": "Team 1",
        "players": [
          "Hi",
          "There",
          "Hi There",
          "D B",
          "A Z",
          "R F"
        ]
      },
      {
        "name": "Team 2",
        "players": [
          "Hii",
          "Thereee",
          "Im Dumb",
          "Poor Chicken"
        ]
      }
    ]
  },
  {
    "name": "test12",
    "slug": "test",
    "description": "asdf",
    "rosters": [
      {
        "name": "Team 1",
        "players": [
          "Hi",
          "There",
          "Hi There",
          "D B",
          "A Z",
          "R F"
        ]
      },
      {
        "name": "Team 2",
        "players": [
          "Hii",
          "Thereee",
          "Im Dumb",
          "Poor Chicken"
        ]
      }
    ]
  },
];

export function getTournamentBySlug(slug) {
  return TOURNAMENTS.find((t) => t.slug === slug) || null;
}

// Autocomplete pool for the "Add player" input: one tournament's players,
// deduped (a player can appear on multiple rosters) and locale-sorted.
export function playerSuggestionsFor(tournament) {
  return [...new Set(tournament.rosters.flatMap((r) => r.players))]
    .sort((a, b) => a.localeCompare(b));
}
