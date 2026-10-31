# Claude Multiplayer server API (v3)

The server is a single file, `api.php`. Every request is a `POST` with a JSON body `{"action": "...", ...}`.
Authenticated actions send the session token in the `X-Deck-Token` header.

- Success: `{"ok": true, ...}`. Errors: HTTP 4xx/5xx with `{"ok": false, "error_code": "...", "error": "..."}`.
- Ids are integers, timestamps are unix seconds, every string is plain text (clients must not render HTML).
- `GET` returns `405 METHOD_NOT_ALLOWED`; bodies over 64 KB return `413 TOO_LARGE`.

## Configuration

Three constants at the top of `api.php`, or the matching environment variables (which win):

| constant      | env                | meaning                                                     |
|---------------|--------------------|-------------------------------------------------------------|
| `SERVER_NAME` | `DECK_SERVER_NAME` | community name                                              |
| `JOIN_KEY`    | `DECK_JOIN_KEY`    | secret required to register (`''` = open registration)      |
| `SETUP_TOKEN` | `DECK_SETUP_TOKEN` | required by the first registration, which becomes the owner |

They are applied whenever their values change; changes made later by the owner in the app are kept.
Optional: `DECK_SECRET` (64 hex chars, encrypts the stored Anthropic key; otherwise a key file is created next
to the database) and `ANTHROPIC_API_KEY` (fallback key for the `@claude` bot).

## Passwords

Clients never send the plaintext password. They send
`hex(PBKDF2-SHA256(password, salt = "cyberdeck/v1|<server url, lowercase>|<username, lowercase>", 200000))`
(see `src/lib/password.js`); the server stores that value with argon2id. Session tokens are stored as SHA-256.

## Public actions

- `server_info` → `{name, motd, version: "3", requires_join_key, requires_setup_token, member_count, registration_open}`
  - `requires_setup_token` is true only while the server has no owner and a setup token is configured.
- `register {username, password, password_confirm, join_key?, setup_token?}` → `{auth_token, user}`
  - The first account becomes the owner. Errors: `SETUP_TOKEN_REQUIRED`, `JOIN_KEY_INVALID`, `REGISTRATION_CLOSED`.
- `login {username, password}` → `{auth_token, user}`
  - `user` = `{id, username, display_nick, avatar_preset, avatar_color, bio, points, elo, role, usage_hidden}`
  - Logins are limited to 12 attempts per 5 minutes per IP (`RATE_LIMITED`).

## Account

- `logout`
- `change_password {old_password, new_password}` (both client-derived values)
- `update_profile {display_nick?, avatar_color?, avatar_preset?, bio?, usage_hidden?}` → `{user}`
  - `avatar_preset` ∈ `CLAUDE_CRAB`, `CLAUDE_GHOST`, `CLAUDE_BOT`, `CLAUDE_CAT` (else `INVALID_AVATAR`).

## Sync

`sync {last_msg_id, telemetry?, new_commits?}` — called every 2 s by the active tab, every 10 s in the background.

- `telemetry` (every block is optional; a missing block means "not shared" and is shown as `null` to others):
  `{status, is_sleeping, ctx_pct, usage: {s, w, reset_s, reset_w, ts}, commits: {day, week}, focus: {project, branch, task}}`
- `new_commits` (max 20 per call): `[{short_hash, project, branch, message, timestamp}]`, sent only when the
  member shares the commit feed with this server.
- Response:
  `{me: {...user, muted_until}, server: {name, motd, settings, my_role, anthropic_key_masked?}, new_messages,
  online_count, members_rev, duels, chess, battleship, commit_feed, game_limits: {spins_5h_left, spins_week_left}}`
  - With `last_msg_id = 0` the last 50 messages are returned.
  - `members_rev` changes when anything visible on the leaderboard changes; clients refetch `members` only then.
  - `commit_feed`: last 25 rows `{id, user_id, handle, project, branch, short_hash, message, created_at}`.
  - `anthropic_key_masked` is present for owner and admins only.

## Members and chat

- `members {q?, page = 1, limit <= 50}` → `{total, page, items}` ordered by points.
  `q` matches the nickname; `owner`, `admin` and `online` are special filters.
  Item: `{user_id, display_nick, avatar_color, avatar_preset, bio, points, elo, trophies, role, is_online, status,
  usage_s, usage_w, usage_ts, usage_masked, ctx_pct, commits_day, commits_week, project, branch, task, rank}`.
- `history {before_id, limit <= 100}` → `{messages}` (oldest first).
- `search_messages {q?, from_nick?, date_from?, date_to?, limit <= 100}` → `{messages}`; `q` needs 2+ characters.
- `send_message {content, reply_to?, msg_type?: "CHAT" | "SNIPPET", snippet_body?}`
- Message: `{id, user_id, sender_nick, avatar_color, msg_type, content, snippet_body, reply_to, created_ts}`;
  `msg_type` ∈ `CHAT`, `SNIPPET`, `SYSTEM`, `CHESS_EVENT`, `TROPHY_EVENT`, `BATTLESHIP_EVENT`.
- `@claude` in a message asks the bot: 5 questions per user per hour and a server-wide daily token budget
  (`claude_daily_tokens`). Upstream errors are logged, never posted.

## Games

Points move inside `BEGIN IMMEDIATE` transactions with conditional updates; balances never go negative.

- `game_spin {kind: "roulette" | "case", bet, choice?}` — roulette pays x2 (red/black) or x14 (green, 1/37);
  the loot case returns ~0.95 on average. Limited by the `spins_5h` / `spins_week` settings (`SPIN_LIMIT`).
- Dice duels: `duel_create {stake, max_players}`, `duel_join {duel_id}`, `duel_cancel {duel_id}`.
  Everyone rolls 1–100; ties for the top re-roll.
- Chess (server-authoritative):
  - `chess_invite {target_nick, stake?}` — several open invites are allowed; the first accepted one starts and
    the others become `TAKEN` (stakes refunded).
  - `chess_accept {challenger_nick | game_id}` (`PLAYER_BUSY` if either player is already in a game),
    `chess_decline {nick | game_id}`.
  - `chess_move {game_id, from, to, promotion?}` with squares like `"e2"`; `chess_move {game_id, resign: true}`.
    The server validates turn and full legality and detects checkmate, stalemate, the fifty-move rule,
    insufficient material and threefold repetition.
    → `{fen, last_move, game_over, outcome, winner_id}`. Errors: `NOT_YOUR_TURN`, `ILLEGAL_MOVE`, `NOT_FOUND`.
  - Payout: the winner gets both stakes + 25 + 2 × ELO gained; a draw refunds the stakes + 10 each.
- Battleship:
  - `bs_invite {target_nick, stake}`, `bs_accept {game_id}`, `bs_decline {game_id}`, `bs_resign {game_id}`
  - `bs_place {game_id, ships: [{x, y, len, dir: "h" | "v"}]}` — exactly ships of length 5, 4, 3, 3, 2 on 10×10,
    no overlaps (`INVALID_FLEET`).
  - `bs_fire {game_id, x, y}` → `{result: "miss" | "hit" | "sunk", sunk_len?, game_over, winner_id?}`
  - Sync item: `{id, opponent_nick, stake, status, is_inviter, my_turn, i_am_ready,
    my_board: {ships, hits_taken, misses_taken}, my_shots, winner_id}`; the enemy fleet never leaves the server.
- Deadlines (`move_timeout_hours`, default 24): the side to move loses an active game after the deadline.
  In battleship placement a single ready player takes the pot (no bonus); if nobody placed, stakes are refunded.
  Invites expire after 24 h with the stake refunded.
- Friday 16:30 (Europe/Rome) showdown: the weekly winner is computed from `commit_feed` rows received this ISO
  week, so client-reported counters never influence prizes.

## Administration

`admin {op, ...}` for the owner and admins:

- `settings`: `name, motd, join_key, registration_open, games_enabled, chess_stakes, max_stake, slow_mode,
  spins_5h, spins_week, claude_daily_tokens (200000), move_timeout_hours (24, 1–336), anthropic_key` (write-only).
  `chess_stakes` also gates battleship stakes; `games_enabled = false` blocks new games and joining.
- `promote`, `demote`, `transfer`, `mute`, `unmute`, `kick`, `ban`, `unban`, `grant_points` with `target_user_id`.
  Admins can act on members only; the owner on anyone.
- `admin_banned` → `{items: [{user_id, display_nick}]}`

## Error codes

`UNAUTHORIZED`, `BANNED`, `MUTED`, `SLOW_MODE`, `RATE_LIMITED`, `JOIN_KEY_INVALID`, `SETUP_TOKEN_REQUIRED`,
`REGISTRATION_CLOSED`, `INVALID_AVATAR`, `SPIN_LIMIT`, `GAMES_DISABLED`, `STAKES_DISABLED`, `ILLEGAL_MOVE`,
`INVALID_FEN`, `INVALID_FLEET`, `NOT_YOUR_TURN`, `PLAYER_BUSY`, `BAD_STATE`, `CONFLICT`, `NOT_FOUND`,
`METHOD_NOT_ALLOWED`, `TOO_LARGE`, `BAD_JSON`, `INTERNAL_ERROR`.

Per-user rate limits: `send_message` 20/10 s, game actions 30/10 s, `sync` 60/30 s, `members` and `history`
30/10 s, `search_messages` 10/10 s.
