# Design

The visual bar: minimal, quiet, and it should look *nice* — not merely functional — on a desktop browser window, an iPad, and an iPhone. Verify on real Safari via the Safari MCP during development.

## Pages

### Landing (`/`)

Truly minimal:

- Wordmark ("Four") and a one-line description.
- A single **New game** action → generates a code client-side, navigates to `/g/<code>`.
- A **Recent games** list from localStorage (code, your seat color, last-played date), only shown when non-empty. Each entry links back into its game.

No hero images, no marketing, no footer clutter.

### Game (`/g/<code>`)

One screen, no scrolling on any target device:

- The 7×6 board, the centerpiece.
- A status line: whose turn / who won / draw — with a dot in the turn player's color.
- Score for the link's lifetime (red n — yellow n).
- A **Rematch** action, visible only when the round is over.
- A **Share** affordance (copy link) so inviting the second player is one tap.
- Theme toggle, small and out of the way.

Spectators see the same screen minus move affordances.

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

Restrained. Animation exists to communicate, not to decorate:

- **Piece drop:** the one signature animation — a piece falls from the top of the column to its resting row, fast (~150–300ms depending on distance), with at most a single small settle. Applies to your moves, live opponent moves, and replayed history *only if* replay is instant otherwise (no slow-motion replays of long games — render historical state immediately, animate only new events).
- **Win:** the four winning cells get a quiet highlight. No confetti, no shaking.
- **Presence pulse:** the scoreboard chips pulse while the corresponding player is connected — liveness at a glance.
- Theme switches and presence changes transition briefly or not at all.
- Respect `prefers-reduced-motion`: with it set, pieces appear in place without the drop.

Nothing else moves.

## Miscellaneous

- The page works with no opponent connected — it's an async game; the UI should feel complete, not "waiting", when playing alone against silence.
- Typeface: Nebula Sans, self-hosted in `public/fonts/` (SIL OFL, license bundled) with a system-font fallback stack. Zero third-party requests.
- The domain appears nowhere in markup, script, or styles.
