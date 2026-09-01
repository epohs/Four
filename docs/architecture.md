# Architecture

## Principles

1. **The client owns the game logic.** Move validation, turn order, win and draw detection, and scorekeeping all happen in the browser. The server never knows the rules of 4-in-a-row.
2. **The server owns the event log.** One append-only log per game is the single source of truth. Everything else — board, whose turn it is, score — is derived by replaying it.
3. **The server enforces structure, not rules.** Four checks on an append, none of them about 4-in-a-row: the sender holds a seat, the index equals the current log length, the event is one of the two known shapes, and the log is under its abuse cap. The server also *stamps* the seat on a move from the sending socket rather than trusting the client's. Together these kill races, duplicates, and seat confusion without any game knowledge. The exact order and rejection reasons are in [protocol.md](protocol.md).
4. **Minimal in every direction.** No accounts, no matchmaking, no anti-cheat. This is a game between two people who trust each other.

## Topology

```
browser (red)     ─┐
browser (yellow)  ─┼── WebSocket ──▶ Cloudflare Worker ──▶ GameDO — one per game code
browser (watcher) ─┘
                                                             ├─ event log     (storage)
                                                             ├─ seat map      (storage)
                                                             ├─ game name     (storage)
                                                             ├─ log epoch     (storage)
                                                             └─ expiry alarm
                                                                   │
                                                                   │ RPC: claim / release
                                                                   ▼
                                                           NameRegistryDO — one, global
                                                             └─ name ⇄ code maps (storage)
```

- The Worker serves the static frontend and routes WebSocket upgrades on `/g/<code>/ws` to the Durable Object for that code. It also permanent-redirects the `*.workers.dev` host to the canonical domain, which is why assets are configured to run the Worker first.
- **`GameDO`** — one instance per game code. Its storage holds the event log, the seat assignments, the game's name, and a log epoch; its in-memory socket set provides broadcast and presence.
- **`NameRegistryDO`** — a single global instance (id `"global"`) that makes game names unique. `GameDO` calls it over RPC; see [Game names](#game-names).
- WebSocket hibernation keeps idle games costless.

## Game identity

- A game code is ~10 characters generated client-side with `crypto.getRandomValues` when the player starts a new game from the landing page.
- The game URL is `/g/<code>`. Any `/g/*` path serves the same single-page client (SPA fallback); the client reads the code from `location.pathname`.
- There is no game creation API. The first connection to a code brings its Durable Object into existence.

## Seats

- Each browser generates a random `playerId` once and keeps it in localStorage.
- On connect, the client presents its `playerId`. The Durable Object assigns seats first-come: first unknown id gets **red**, second gets **yellow**, everyone after is a **spectator** (read-only).
- Reconnecting with a known id returns the same seat, so a refresh or a dropped connection never flips your color. A seat belongs to a browser, not a device pool — opening the link in a different browser joins as whatever seat (or spectator role) is left.

## Game names

A game is identified by its code, but it can also carry a human name so the landing page's recent list reads as something other than ten random strings.

- Only **red** — the creator, being the first seat assigned — can set the name. The client shows the rename affordance to nobody else, so the server ignores anyone else silently rather than rejecting them.
- The name is stored in `GameDO` and broadcast to everyone at the game. It is not an event and never enters the log: it is current state, not history, and replaying a rename would mean nothing.
- Names are **globally unique**, case-insensitively, which is what `NameRegistryDO` exists for. It holds two mirrored maps — name → code and code → name — and its single-threaded execution is what makes claim-then-store race-free without any locking.
- A collision does not fail. The registry grants a numbered variant instead (`"Pomme"` → `"Pomme 2"`, and when the suffix wouldn't fit in the 16-character limit the base gives way: `"Pomme's game Sun"` → `"Pomme's game Su2"`), and the granted name is what gets stored and broadcast, so the namer can see what happened and try again. This is deliberately an error defined out of existence rather than a rejection to handle.
- Renaming releases the game's previous name. Expiry releases it too, so a dead game does not hold a name hostage; if the registry is unreachable at that moment the name stays reserved, which is a nuisance and never worth blocking the deletion over.

## The event log

The log holds exactly two event kinds:

- `move` — a column number, stamped by the server with the seat that sent it.
- `new_round` — a round boundary, starting a fresh board.

Rules for deriving state from the log (all client-side):

- The board is replayed from the last `new_round` (or the log start).
- Within a round, seats alternate. **Red starts round 1; the starting seat alternates each round** (yellow starts round 2, and so on), regardless of who won.
- A round ends when a client detects four-in-a-row (horizontal, vertical, or either diagonal) or a full board (draw).
- Score is the count of rounds each seat has won across the whole log. Draws score nothing. There is no other score storage anywhere.
- The client only *offers* moves that are legal (your turn, column not full, round not over) and only offers rematch once the round is over — but these are client rules. The server accepts any structurally valid append.
- Derivation is where the rules live, so it is also where impossible history gets filtered: replay **shrugs off** any event the rules can't produce — a move into a full column, a move after the round ended, a move out of turn, and a `new_round` before the round is over. A hostile or buggy client can pollute the log with such events, but every honest client derives the same clean game past them.

## Synchronization

- On connect, the Durable Object sends your seat plus the log — in full for a first join, or just the suffix past what the client already holds (delta sync, guarded by a per-log **epoch** so a client from an expired game's previous life can't mistake an empty delta for "caught up"). See [protocol.md](protocol.md).
- Live moves broadcast to all connected sockets in the game; each client appends to its local copy and updates incrementally.
- If your opponent is offline, your move still lands in the log — they replay it whenever they return. This is what makes asynchronous play work.
- The append-index contract means a client that has fallen behind gets its append rejected with the expected index; it re-syncs and retries. See [protocol.md](protocol.md).

Not everything that travels between clients is history. Three kinds of message cross the wire, and only the first is stored:

| | Stored | Ordered by index | Survives a reconnect |
| --- | --- | --- | --- |
| **Events** (`move`, `new_round`) | yes, in the log | yes | yes — replayed from the log |
| **State** (game name, presence) | name yes, presence no | no | name yes, presence recomputed |
| **Signals** (`dismiss`) | no | no | no |

A **signal** is transient coordination relayed to everyone else at the game and kept nowhere. The server does not know what one means; it is fan-out and nothing else. Signals stay clear of the log on purpose: a dismissal is not something a later replay should reproduce, it carries no index, and two arriving at once cannot collide the way two appends would. The only one in use is `dismiss`, which is how either player clearing the end-of-round celebration clears it for both of them and every spectator.

## Surviving bad connections

The design assumes phones on flaky networks:

- **Heartbeat:** the client pings over quiet stretches; the Durable Object's auto-response answers without waking a hibernated game. A long silence means the socket is dead even though it looks open — the client closes it and reconnects. Without this, a silently dropped TCP connection would show a live board that never updates.
- **Reconnect:** exponential backoff with jitter, capped low (~10s) because an attempt is one cheap request and iOS doesn't reliably fire wake events. Short-circuited by every wake signal the browser offers — `online`, `focus`, `pageshow`, a tab becoming visible — and by tapping the board while disconnected. A connection attempt stuck in `CONNECTING` is abandoned after 10s.
- **In-flight appends:** an append whose confirmation never arrives triggers a resync after a few seconds rather than leaving the board frozen.
- **Bandwidth:** reconnects fetch only the log suffix (delta sync above); static assets carry cache headers so fonts and icons are never re-downloaded, and HTML/JS/CSS revalidate as cheap 304s.

## Presence

Presence answers one question: is the other player at the game right now? It is computed, never stored — a seat is present while at least one socket holding it is open on the game screen, so the socket set *is* the presence state and there is nothing to keep in sync.

- Broadcast when a socket says hello and when a **seated** game socket closes. A spectator or pre-hello socket leaving changes nothing, so nothing is sent.
- **Being at the game is the definition.** Hiding the tab closes the socket, which marks you away exactly as if you had clicked Leave; returning reconnects and marks you back. This is why the reconnect logic refuses to open a socket while the tab is hidden — a backoff timer firing in a background tab would otherwise report a player as present when they are not looking.
- The landing page's turn-ring sockets say `context: "landing"` in their hello and never count toward presence, for the same reason: watching a ring on the landing page is not being at the game.
- Never written to the log, and a reconnect recomputes it from scratch. See [protocol.md](protocol.md).

## Persistence and expiry

- Durable Object storage is the only server-side persistence: each `GameDO` (log, seats, name, epoch) plus the one `NameRegistryDO` (the name maps).
- localStorage holds only the browser's `playerId`, its theme preference, and the landing page's recent-games list — for each game, its code, your seat, the name if it has one, whether the current round has finished, and when you last played it. All of it is convenience; none of it is authoritative, and clearing it loses your seat but not any game.
- Every connection, append, or rename resets a `GameDO` alarm 90 days out. Signals do not — clearing a celebration is not the kind of activity that should keep a game alive for another three months. When the alarm fires the game's storage is deleted and its name released; the link then behaves as a brand-new empty game, with a fresh epoch so stale clients full-sync rather than mistaking an empty delta for "caught up".

## Accepted tradeoffs

- No server-side rule enforcement, by design. A hostile client can still bloat the log with impossible events (up to the abuse cap), but honest clients filter them out during derivation, so the worst it achieves is wasted bytes.
- No cross-browser identity: your seat is tied to one browser's localStorage. Clearing site data forfeits the seat (the game itself survives on the server).
- Two players and spectators only; no lobbies, no discovery.
