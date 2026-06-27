# League Import — ESPN & Yahoo

Import a full league (settings + every team's roster) from ESPN or Yahoo and map
the rostered players onto our board. Built as a thin, provider-agnostic layer:
each adapter turns a platform's payload into a normalized league; one endpoint
matches players and persists it.

```
integrations/
  base.py       NormLeague / NormTeam / NormPlayer + app-shaped settings builder
  matching.py   name/team normalization -> fantasy_players ids (pure, tested)
  espn.py       unofficial ESPN read API -> NormLeague
  yahoo.py      Yahoo OAuth2 + official API -> NormLeague
  selftest.py   fixture tests for the deterministic core (no net / no db)
```

Run the deterministic tests anytime: `cd backend && python -m integrations.selftest`.

## Endpoints

- `POST /api/leagues/import` — create a league from a platform league. Body:
  ```jsonc
  {
    "provider": "espn" | "yahoo",
    "ext_id": "123456",        // ESPN leagueId, or Yahoo league key "nfl.l.123456"
    "season": 2026,             // player pool to match against (and ESPN league season)
    "name": "optional override",
    // ESPN private leagues only:
    "espn_s2": "...", "swid": "{...}", "my_team": "Team Ari",
    // Yahoo only (from the OAuth helper below):
    "access_token": "...", "my_guid": "..."
  }
  ```
  Returns `{ league, report }` where `report` has `players_matched`,
  `players_unmatched`, `unmatched_sample`, and `mine_found`. Matched players
  become draft picks (auction price carried over when known); the team flagged as
  "mine" is marked accordingly so the board shows your roster.

- `GET  /api/integrations/yahoo/auth-url` — the Yahoo consent URL to open.
- `POST /api/integrations/yahoo/exchange` `{ "code": "..." }` — exchange the
  returned code for `{ access_token, refresh_token, guid }`.

All three require a logged-in user (normal JWT).

## ESPN auth

ESPN has **no official API**; we read the same host the web app uses. Public
leagues need nothing. **Private** leagues need two cookies from a logged-in
espn.com session (DevTools → Application → Cookies): `espn_s2` and `SWID`
(keep the braces). Paste them in the import dialog. These are fragile — ESPN can
change the shape without notice.

## Yahoo auth (one-time app setup)

Yahoo's API is official and uses OAuth2, so it needs a developer app:

1. Create an app at <https://developer.yahoo.com/apps/> with **Fantasy Sports →
   Read** permission.
2. Set its **Redirect URI** to a page you control (it just needs to display the
   `code` Yahoo returns; the frontend dialog asks you to paste it).
3. In the Railway **backend** service Variables, set:
   - `YAHOO_CLIENT_ID`
   - `YAHOO_CLIENT_SECRET`
   - `YAHOO_REDIRECT_URI` (must exactly match the app's redirect URI)
4. Redeploy. The import dialog's "Authorize with Yahoo" button now works.

## Player matching

Platforms use their own player ids; we key by `(name, pos, team)`. `matching.py`
normalizes names (drops accents/punctuation/suffixes like Jr/III) and
canonicalizes team abbreviations (JAX/JAC, WAS/WSH, LV/OAK, …). Name collisions
are resolved by team; if still ambiguous it declines rather than guess wrong.
Defenses match on team abbreviation. Anything unmatched is reported, not
silently dropped.

## Status / validation

- The **deterministic core** (settings translation, roster mapping, player
  matching) is fixture-tested and passing — that's where the real logic lives.
- The **live provider fetches** (`espn.fetch_league`, `yahoo.fetch_league`) were
  written against the platforms' documented response shapes but **could not be
  exercised from the build sandbox** (its egress policy blocks ESPN/Yahoo). They
  run from prod (Railway has open egress). Validate against a real league there;
  if a field path is off, the parsers are defensive and isolated to one function
  each, so adjustments are small. Yahoo's deeply-nested JSON is the most likely
  to need a tweak against a live response.
