# Design

The visual bar: minimal, quiet, and it should look *nice* — not merely functional — on a desktop browser window, an iPad, and an iPhone. Verify on real Safari via the Safari MCP during development.

## Pages

### Landing (`/`)

Truly minimal:

- Wordmark ("Four") and a one-line description.
- A single **New game** action → generates a code client-side, navigates to `/g/<code>`.
- A **Recent games** list from localStorage, shown only when non-empty and capped at the ten most recent. Each row carries a chip in the seat you hold there (neutral if you only watched), the game's **name** — or its code, until someone names it — an "in progress" badge while the current round is unfinished, and the date you last played. The row links back into the game; a **×** removes it, fading out first so the list doesn't jump.
- **Turn rings.** An unfinished game where you hold a seat gets a ring on its chip when it's your move, kept live by a light socket per such game so it reacts the moment your opponent plays. These sockets never count toward presence — watching a ring is not being at the game. See [architecture.md](architecture.md).

No hero images, no marketing, no footer clutter.

### Game (`/g/<code>`)

One screen, no scrolling on any target device:

- The wordmark on its own line at the top, linking home.
- The game's **name** beside the score — the code until it has one. Only the creator (red) gets it as a button; clicking swaps it for an inline input capped at the same 16 characters the server enforces, committed on Enter or blur, abandoned on Escape. What comes back may be a numbered variant of what was typed (names are unique — see [architecture.md](architecture.md)), and the HUD shows what was actually granted, so the namer can see what happened.
- The 7×6 board, the centerpiece.
- A status line: whose turn / who won / draw — with a dot in the turn player's color.
- Presence means being at the game: hiding the tab (switching tabs/apps, minimizing) closes the socket and marks you away until you return — the same signal as clicking Leave.
- Score for the link's lifetime (red n — yellow n).
- A **Rematch** action, visible only when the round is over.
- A **Share** affordance (copy link) so inviting the second player is one tap, and a **Leave** action back to the landing page.
- Theme toggle, small and out of the way.

Spectators see the same screen minus move affordances, and never get the rename button.

## Board

- CSS Grid, 7 columns × 6 rows, square cells.
- Sized from the viewport: the limiting dimension (height on phones in landscape, width in portrait) drives cell size via `min()`/viewport units — the whole board always fits without scrolling.
- Touch targets are full columns, not cells: tapping anywhere in a column drops there. On pointer devices, hovering a column shows a subtle ghost piece at the drop position.

## Responsive targets

- **iPhone (portrait):** board spans nearly full width; status and score stack above/below. Everything reachable one-handed.
- **iPad / desktop:** board comfortably centered with whitespace; controls beside or below the board, never crowding it.
- Test at minimum: iPhone-class (~390pt wide), iPad-class (~820pt), and a desktop window (~1200pt+), portrait and landscape on the touch sizes.

## Theming

- Light and dark themes, as CSS custom properties on `:root`.
- Default follows `prefers-color-scheme`; if it can't be determined confidently, default to **light**.
- A manual toggle overrides the system setting and persists in localStorage; the stored choice wins on later visits.
- Piece colors (red/yellow) must hold sufficient contrast against the board in both themes, and empty vs. filled cells must be distinguishable without relying on color alone (e.g., depth/border on empty slots).

## Animation

Restrained during play, with one deliberate exception when a round ends. Animation exists to communicate, not to decorate — the end of a round is worth celebrating, a move in progress is not:

- **Piece drop:** the one signature animation — a piece falls from the top of the column to its resting row, fast (~150–300ms depending on distance), with at most a single small settle. Applies to your moves, live opponent moves, and replayed history *only if* replay is instant otherwise (no slow-motion replays of long games — render historical state immediately, animate only new events).
- **Win:** the four winning cells get a quiet highlight, then the celebration below.
- **Presence pulse:** the scoreboard chips pulse while the corresponding player is connected — liveness at a glance.
- Theme switches and presence changes transition briefly or not at all.
- Respect `prefers-reduced-motion`: with it set, pieces appear in place without the drop, and the celebration keeps its verdict and emoji — both fading in place, with no growth, no fall and no paint.

Nothing else moves.

### Celebration

A round ending raises one full-viewport layer over everything: an emoji centered on the board, and — for a win — paint splatters behind it. Timings and constants live in `createCelebration()` in `public/app.js`.

- **Trigger:** once per round, and only when the round ends *live* in front of you. Opening or resyncing a finished game replays the board, never the moment — an async player returning the next day gets a board, not a trophy. Fires ~280ms after the winning move, just long enough for the piece to land.
- **Title:** the verdict in Nebula Sans Bold (700, the heaviest weight shipped), hung above the emoji and always larger than the "Four" wordmark. Sized from script, because it depends on three things at once: the room the emoji leaves above it, the viewport height, and how long the words are — "Yellow wins" on a narrow phone can't take the size "Draw" does. The character-count estimate is corrected against the text's measured width, so it never overflows. White over the scrim, with a soft black shadow — needed at the win's lighter 50%, where a pale page only half-darkens and white letters would otherwise sit at roughly 2:1 against it.
- **Emoji:** the entrance varies by outcome (below); the resting size comes from the board's width (~72%), capped at 288px and at 34% of viewport height so a short landscape phone still has room for the title.
- **Paint splatters:** two stacked canvases between the board and the emoji. **The paint is permanent** — nothing fades until you dismiss it. The first splats land on the opening frame, in the top half; the region opens to the whole viewport over ~1.2s, and the rate climbs the whole way (9 → 34 splats/sec over 3s) so the field reads as still gathering pace. Splat centers are inset from the edges and placed away from paint already down; the paint itself may bleed off. Each splat throws 24–38 droplets outward on a closed-form ease and stops. Droplets are ellipses, not circles — stretched along the direction they flew and further the harder they were thrown, topping out around 2:1 with the typical one nearer 1.2:1, at constant area so shape varies without coverage varying. A field of perfect circles reads as dots rather than splatter.
- **Density:** the build ends at a dot budget scaled to the viewport — one dot per ~142 CSS px² of screen, floored at 1800 and capped at 4300 — so a phone gets the same *density* as a desktop rather than the same count, and the weakest hardware draws the smallest field. Roughly 3.8s of build on a phone, 5.8s on a desktop. The spawn rate is deliberately not scaled alongside the budget: raising density lengthens the build rather than accelerating it, which keeps the pace of the build the same as the density is tuned.
- **Dismissal:** a tap, click, Escape, Enter or Space anywhere. Every dot fades on its own staggered clock (~280ms of spread, ~170ms each), so the field comes apart dot by dot rather than blinking off as one sheet. Gone in ~450ms, returning the board, Rematch and Leave.
- **Dismissal is shared.** Either player clearing the moment clears it for both of them and for every spectator, over the `signal` relay in [protocol.md](protocol.md) — one person shouldn't be left staring at a screen the other has already moved on from. A spectator's click clears only their own screen.
- **Cost:** only splats still expanding are redrawn per frame — settled paint is drawn once onto its own canvas and left there, so a frame costs the same (~800 dots at peak, ~22 splats in flight) whether 3 splats or 96 have landed. Once the last splat settles the animation loop *stops entirely*, and the finished field sits on screen at zero CPU for as long as it takes someone to click. The dissolve is the only pass that touches every dot, which is why the density cap lives where it does.
- **Per-outcome**, all sharing the same placement, dismissal and 700ms-or-less arrival. `CELEBRATIONS` in `public/app.js` is the whole mapping:
  - **Win** — "You win", 🏆 swelling up from 12px over 700ms, paint splatters in front of a 50% black scrim. Lighter than the other two on purpose: the paint needs a ground to read against, not a blackout, and half-darkening a pale page gives the colours more contrast than the bare page does.
  - **Loss** — "You lose", 😞 over an 85% black scrim, falling in from above the viewport onto the board's center over 640ms, on the same gravity curve and single small bounce as a dropped piece. No paint.
  - **Draw** — "Draw", 🤝 over an 85% black scrim, slamming in over 320ms: arrives oversized as it fades up, compresses past its resting size on impact, rebounds and settles. No paint.
  - **Spectating a win** gets the winner's treatment, retitled to name the winner ("Red wins") — they didn't lose, they watched somebody win.

The paint splatter effect is our own canvas implementation, inspired by [confetti.ts](https://github.com/LoaderB0T/confetti.ts) (MIT) but sharing no code with it — this project ships zero third-party assets.

## Miscellaneous

- The page works with no opponent connected — it's an async game; the UI should feel complete, not "waiting", when playing alone against silence.
- Typeface: Nebula Sans, self-hosted in `public/fonts/` (SIL OFL, license bundled) with a system-font fallback stack. Zero third-party requests.
- The domain appears nowhere in markup, script, or styles.
