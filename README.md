# Four

A minimal, two-player 4-in-a-row game you play over a shared link — live or asynchronously.

Create a game, text the link to a friend, and take turns dropping pieces. Both of you at your screens? Moves appear instantly. One of you busy? Come back tonight; the game is exactly where you left it.

## How it works, in one paragraph

The client owns all game logic — move validation, win detection, score — and the server owns nothing but an append-only event log per game. Every device derives the entire game state by replaying that log. The server never learns the rules of the game; it enforces only that appends arrive in order and come from the seat that owns them. See [docs/architecture.md](docs/architecture.md) for the full model and [docs/protocol.md](docs/protocol.md) for the wire contract.

## Stack

- **Frontend:** vanilla HTML, CSS, and JavaScript. No framework, no build step.
- **Backend:** a Cloudflare Worker with two Durable Object classes (TypeScript) — `GameDO`, one instance per game holding that game's event log, and `NameRegistryDO`, a single global instance that keeps game names unique.
- **Transport:** native WebSockets.

## Playing

- Visiting the bare domain shows a minimal landing page: start a new game, or reopen a recent one (remembered in your browser's localStorage).
- A game lives at `/g/<code>`. The first browser to open a game gets the red seat, the second gets yellow, and anyone else watches as a spectator.
- Whoever created the game can click its name in the header to rename it, so the recent list reads as something better than ten random characters. Names are unique across all games; asking for one that's taken gets you a numbered variant.
- Either player can start a rematch once a round is won or drawn. Score accumulates across rounds for the life of the link.
- The end of a round gets a celebration — a verdict, an emoji, and paint splatters for a win. A tap clears it for everyone at the game.
- Games expire 90 days after the last activity.

## Local development

```sh
npm install
npm run dev      # wrangler dev
npm run check    # tsc --noEmit, the only build-time gate
```

Then open the printed local URL. Two browser windows on the same game code make a full match — seats are per-browser, so two windows of the same browser share one seat; use two different browsers (or a private window) to hold both.

## Deployment

```sh
npm run deploy   # wrangler deploy
```

Route the Worker to your domain in the Cloudflare dashboard (or via `routes` in `wrangler.jsonc`). The client derives its WebSocket URL from `location`, so no domain is configured anywhere in the code.

## Docs

- [docs/architecture.md](docs/architecture.md) — the event-log model, seats, game names, derivation rules, presence, expiry
- [docs/protocol.md](docs/protocol.md) — WebSocket message schemas and the append contract
- [docs/design.md](docs/design.md) — layout, responsive targets, theming, animation
