# Architecture

## Principles

1. **The client owns the game logic.** Move validation, turn order, win and draw detection, and scorekeeping all happen in the browser. The server never knows the rules of 4-in-a-row.
2. **The server owns the event log.** One append-only log per game is the single source of truth. Everything else — board, whose turn it is, score — is derived by replaying it.
3. **The server enforces structure, not rules.** Exactly two checks: an append's index must equal the current log length, and a move must come from the connection holding that seat. These kill races, duplicates, and seat confusion without any game knowledge.
4. **Minimal in every direction.** No accounts, no matchmaking, no anti-cheat. This is a game between two people who trust each other.

## Topology

```
browser (red) ──┐
browser (yellow)├── WebSocket ──> Cloudflare Worker ──> Durable Object (one per game)
browser (watcher)┘                                        ├─ event log   (storage)
                                                          ├─ seat map    (storage)
                                                          └─ expiry alarm
```

- The Worker serves the static frontend and routes `/g/<code>` WebSocket upgrades to the Durable Object for that code.
- Each game code maps to one Durable Object instance. Its storage holds the event log and the seat assignments; its in-memory socket set provides broadcast and presence.
- WebSocket hibernation keeps idle games costless.

## Game identity

- A game code is ~10 characters generated client-side with `crypto.getRandomValues` when the player starts a new game from the landing page.
- The game URL is `/g/<code>`. Any `/g/*` path serves the same single-page client (SPA fallback); the client reads the code from `location.pathname`.
- There is no game creation API. The first connection to a code brings its Durable Object into existence.

## Seats

- Each browser generates a random `playerId` once and keeps it in localStorage.
- On connect, the client presents its `playerId`. The Durable Object assigns seats first-come: first unknown id gets **red**, second gets **yellow**, everyone after is a **spectator** (read-only).
- Reconnecting with a known id returns the same seat, so a refresh or a dropped connection never flips your color. A seat belongs to a browser, not a device pool — opening the link in a different browser joins as whatever seat (or spectator role) is left.

## The event log

The log holds exactly two event kinds:

- `move` — a column number, stamped by the server with the seat that sent it.
- `new_round` — a round boundary, starting a fresh board.

Rules for deriving state from the log (all client-side):

- The board is replayed from the last `new_round` (or the log start).
- Within a round, seats alternate. **Red starts round 1; the starting seat alternates each round** (yellow starts round 2, and so on), regardless of who won.
- A round ends when a client detects four-in-a-row (horizontal, vertical, or either diagonal) or a full board (draw).
- Score is the count of rounds each seat has won across the whole log. Draws score nothing. There is no other score storage anywhere.
- The client only *offers* moves that are legal (your turn, column not full, round not over) and only offers rematch once the round is over — but these are client rules. The server accepts any structurally valid append. Between friends, a corrupt log is a shrug, and starting a new link is the remedy.

## Synchronization

- On connect, the Durable Object sends the full log plus your seat. The client rebuilds state and renders.
- Live moves broadcast to all connected sockets in the game; each client appends to its local copy and updates incrementally.
- If your opponent is offline, your move still lands in the log — they replay it whenever they return. This is what makes asynchronous play work.
- The append-index contract means a client that has fallen behind gets its append rejected with the expected index; it re-syncs and retries. See [protocol.md](protocol.md).

## Presence

Connect and disconnect broadcast an ephemeral presence message so the UI can show whether the other seat is currently here. Presence is never written to the log.

## Persistence and expiry

- The Durable Object's storage is the only persistence. localStorage holds only the browser's `playerId`, theme preference, and a list of recently played game codes for the landing page.
- Every connection or append resets a Durable Object alarm 90 days out. When the alarm fires, the game's storage is deleted; the link then behaves as a brand-new empty game.

## Accepted tradeoffs

- A hostile or buggy client can append legal-looking-but-wrong events; the other client's derivation will simply reflect them. No server-side rule enforcement, by design.
- No cross-browser identity: your seat is tied to one browser's localStorage. Clearing site data forfeits the seat (the game itself survives on the server).
- Two players and spectators only; no lobbies, no discovery.
