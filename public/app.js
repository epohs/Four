"use strict";

/* ================================================================
 * Pure game logic — everything derived by replaying the event log.
 * The server knows none of this; see docs/architecture.md.
 * Board is [row][col], row 0 = bottom. 7 columns × 6 rows.
 * ================================================================ */

function emptyBoard() {
  return Array.from({ length: 6 }, () => new Array(7).fill(null));
}

function dropRow(board, col) {
  for (let r = 0; r < 6; r++) if (!board[r][col]) return r;
  return -1;
}

// If the piece at (row, col) completes four-in-a-row, return the run's cells.
function winFrom(board, row, col) {
  const seat = board[row][col];
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    const cells = [[row, col]];
    for (const s of [1, -1]) {
      let r = row + dr * s, c = col + dc * s;
      while (r >= 0 && r < 6 && c >= 0 && c < 7 && board[r][c] === seat) {
        cells.push([r, c]);
        r += dr * s;
        c += dc * s;
      }
    }
    if (cells.length >= 4) return cells;
  }
  return null;
}

function otherSeat(seat) {
  return seat === "red" ? "yellow" : "red";
}

/*
 * Replay the whole log into current state.
 * Round boundaries are new_round events; red starts round 1 and the
 * starting seat alternates each round regardless of who won. Score is
 * rounds won across the whole log; draws score nothing. Structurally
 * valid but impossible events (full column, move after the round
 * ended, a move out of turn, new_round before the round is over) are
 * shrugged off, per the architecture doc — derivation is where the
 * rules live, so it is also where impossible history gets filtered.
 */
function derive(log) {
  const score = { red: 0, yellow: 0 };
  let round = 1;
  let board = emptyBoard();
  let over = null; // { winner: "red"|"yellow"|null (draw), cells: [[r,c],...] }
  let moves = 0;
  let lastMove = null;

  for (const ev of log) {
    if (ev.kind === "new_round") {
      if (!over) continue; // a live (or unstarted) round can't be restarted
      round++;
      board = emptyBoard();
      over = null;
      moves = 0;
      lastMove = null;
      continue;
    }
    if (ev.kind !== "move" || (ev.seat !== "red" && ev.seat !== "yellow")) continue;
    if (!Number.isInteger(ev.col) || ev.col < 0 || ev.col > 6) continue;
    if (over) continue;
    const starter = round % 2 === 1 ? "red" : "yellow";
    if (ev.seat !== (moves % 2 === 0 ? starter : otherSeat(starter))) continue;
    const row = dropRow(board, ev.col);
    if (row < 0) continue;
    board[row][ev.col] = ev.seat;
    moves++;
    lastMove = { row, col: ev.col, seat: ev.seat };
    const cells = winFrom(board, row, ev.col);
    if (cells) {
      over = { winner: ev.seat, cells };
      score[ev.seat]++;
    } else if (moves === 42) {
      over = { winner: null, cells: [] };
    }
  }

  const starter = round % 2 === 1 ? "red" : "yellow";
  const turn = over ? null : moves % 2 === 0 ? starter : otherSeat(starter);
  return { round, board, over, score, turn, lastMove };
}

/* ================================================================
 * Connection layer — the tuning and the two pieces both pages share.
 * The game page and the landing page's turn-rings open different
 * sockets for different reasons, but they die the same way and they
 * resynchronize the same way.
 * ================================================================ */

// Heartbeat: ping over quiet stretches, and treat a long silence as a
// dead socket even though it still reads OPEN.
const HEARTBEAT_MS = 20000;
const SILENCE_MS = 45000;
// A socket can sit in CONNECTING for the browser's whole TCP timeout on
// a bad network; give up sooner so the retry path takes over.
const CONNECT_TIMEOUT_MS = 10000;
// Grace on waking, so a stale timestamp from a suspended tab doesn't
// kill a live socket before its pong has had time to land.
const WAKE_GRACE_MS = 25000;

// Game-page reconnect. The cap is low because an attempt is one cheap
// request and iOS doesn't reliably fire `online` — the timer is the
// recovery path there.
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 10000;
// Turn-ring reconnect. Lower stakes and one socket per in-progress
// game, so it backs off much further before giving the server another
// round of attempts.
const RING_RETRY_MIN_MS = 5000;
const RING_RETRY_MAX_MS = 60000;
// Close code 1013 is the server shedding load (its per-game socket
// cap). Come back, but not soon enough to re-apply the pressure.
const OVERLOADED_RETRY_MS = 60000;

// An append whose confirmation never lands: ask for the log rather than
// leaving the board frozen.
const APPEND_TIMEOUT_MS = 8000;
// How many games the landing page remembers.
const RECENT_LIMIT = 10;
// Row fade before a removed game leaves the list. Must match the
// transition on #recent-list li in style.css.
const ROW_FADE_MS = 200;
// Longest game name. Must match MAX_NAME in src/worker.ts, which is
// what actually enforces it — this only stops the input accepting
// characters the server would silently drop.
const MAX_NAME = 16;

/**
 * Fold a welcome/log payload into a local event log and return the
 * result. Delta sync: the server sends only the events past what the
 * client's hello/resync claimed to hold, and `from` marks that join
 * point. `from: 0` — an epoch mismatch, or a log reset by expiry —
 * replaces wholesale. Pure; the caller owns where the log lives, and
 * the epoch alongside it.
 */
function mergeLog(log, msg) {
  const events = Array.isArray(msg.log) ? msg.log : [];
  const from = Number.isInteger(msg.from) ? msg.from : 0;
  return from > 0 && from <= log.length ? log.slice(0, from).concat(events) : events;
}

/**
 * Keep sockets honest over quiet stretches. TCP dies silently on flaky
 * networks — the socket still reads OPEN while frames go nowhere — so
 * ping periodically, and close anything that has heard nothing for
 * SILENCE_MS so the caller's normal reconnect path takes over. The
 * server answers pings from the Durable Object's auto-response, so a
 * hibernated game is never woken by a keepalive.
 *
 * `sockets` is called each tick and yields whatever should be checked
 * now, as objects carrying the socket and when it last heard anything.
 * Called rather than captured because both callers replace their
 * sockets over the life of the page.
 */
function startHeartbeat(sockets) {
  setInterval(() => {
    for (const { socket, lastAlive } of sockets()) {
      if (!socket || socket.readyState !== WebSocket.OPEN) continue;
      if (Date.now() - lastAlive > SILENCE_MS) socket.close();
      else socket.send("ping");
    }
  }, HEARTBEAT_MS);
}

/** The ws:// or wss:// URL for a game code, derived from `location`. */
function socketUrl(code) {
  const scheme = location.protocol === "https:" ? "wss://" : "ws://";
  return scheme + location.host + "/g/" + code + "/ws";
}

/* ================================================================ */

if (typeof module !== "undefined" && module.exports) {
  module.exports = { emptyBoard, dropRow, winFrom, derive, otherSeat, mergeLog };
}
if (typeof document !== "undefined") main();

function main() {
  const $ = (id) => document.getElementById(id);

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* private mode etc.; the game still works, identity just won't stick */
      }
    },
  };

  // The Worker's ws route matches [A-Za-z0-9_-]+; generate from a subset
  // with the ambiguous characters (0/O, 1/l/I) dropped.
  const ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  function randomCode(length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    let out = "";
    for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
    return out;
  }

  function playerId() {
    let id = store.get("four:playerId", null);
    if (!id) {
      id = randomCode(16);
      store.set("four:playerId", id);
    }
    return id;
  }

  /* ---------------- theme ---------------- */

  const root = document.documentElement;
  const themeToggle = $("theme-toggle");
  const storedTheme = store.get("four:theme", null);
  if (storedTheme === "light" || storedTheme === "dark") root.dataset.theme = storedTheme;

  function isDark() {
    if (root.dataset.theme) return root.dataset.theme === "dark";
    return matchMedia("(prefers-color-scheme: dark)").matches;
  }
  function paintToggle() {
    themeToggle.textContent = isDark() ? "☼" : "☾"; // ☼ / ☾
  }
  themeToggle.addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    root.dataset.theme = next;
    store.set("four:theme", next);
    paintToggle();
  });
  // With no manual override the glyph tracks the system scheme.
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paintToggle);
  paintToggle();

  /* ---------------- helpers ---------------- */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  /* ---------------- routing ---------------- */

  const match = location.pathname.match(/^\/g\/([A-Za-z0-9_-]+)$/);
  if (match) initGame(match[1]);
  else initLanding();

  /* ---------------- landing ---------------- */

  function initLanding() {
    $("landing").hidden = false;
    $("new-game").addEventListener("click", () => {
      location.href = "/g/" + randomCode(10);
    });

    const recent = store.get("four:recent", []);
    if (!Array.isArray(recent) || recent.length === 0) return;
    $("recent").hidden = false;
    const list = $("recent-list");

    // Per-game live state, keyed by code, for in-progress games where the
    // local player holds a seat. Keeps a light WebSocket open per game so
    // the turn ring can react the moment the opponent moves.
    const live = new Map();

    for (const game of recent) {
      if (typeof game.code !== "string" || !/^[A-Za-z0-9_-]+$/.test(game.code)) continue;
      const item = el("li");
      const remove = el("button", "remove", "×");
      remove.title = "Remove";
      remove.setAttribute(
        "aria-label",
        "Remove " + (game.name || game.code) + " from recent games",
      );
      remove.addEventListener("click", () => removeRecent(game.code, item));
      item.append(remove);
      const link = el("a");
      link.href = "/g/" + game.code;
      const seatClass = game.seat === "red" || game.seat === "yellow" ? game.seat : "spectator";
      const chip = el("span", "chip " + seatClass);
      link.append(chip);
      // A named game shows its name; unnamed ones fall back to the code.
      if (typeof game.name === "string" && game.name) {
        link.append(el("span", "recent-name", game.name));
      } else {
        link.append(el("code", "recent-name", game.code));
      }
      if (game.done === false) link.append(el("span", "badge", "in progress"));
      link.append(
        el(
          "time",
          null,
          Number.isFinite(game.last) ? new Date(game.last).toLocaleDateString() : "",
        ),
      );
      item.append(link);
      list.append(item);

      // Live turn-ring: only in-progress player games are worth a socket.
      // These hello with context "landing", so they drive the ring but
      // never count toward presence — leaving a game makes you away.
      if (game.done === false && (game.seat === "red" || game.seat === "yellow")) {
        live.set(game.code, {
          code: game.code,
          chip,
          seat: game.seat, // provisional; the server welcome is authoritative
          log: [],
          socket: null,
        });
      }
    }

    // The ring shows when it's the seated player's turn in a live round.
    function applyRing(entry) {
      const state = derive(entry.log);
      const myTurn =
        !state.over && state.turn === entry.seat && (entry.seat === "red" || entry.seat === "yellow");
      entry.chip.classList.toggle("you", myTurn);
    }

    function connectLanding(entry) {
      // Same rule as the game page: a hidden tab needs no sockets; the
      // visibilitychange handler reconnects when it becomes visible.
      if (document.hidden) return;
      const socket = new WebSocket(socketUrl(entry.code));
      entry.socket = socket;
      // A bad network can leave a socket stuck CONNECTING for a long
      // time; give up so the close handler schedules the retry.
      const connectTimeout = setTimeout(() => {
        if (socket.readyState === WebSocket.CONNECTING) socket.close();
      }, CONNECT_TIMEOUT_MS);
      socket.addEventListener("open", () => {
        clearTimeout(connectTimeout);
        entry.backoff = RING_RETRY_MIN_MS;
        entry.lastAlive = Date.now();
        socket.send(
          JSON.stringify({
            type: "hello",
            playerId: playerId(),
            have: entry.log.length,
            epoch: entry.epoch,
            context: "landing",
          }),
        );
      });
      socket.addEventListener("message", (e) => {
        entry.lastAlive = Date.now();
        if (e.data === "pong") return;
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        switch (msg.type) {
          case "welcome":
            if (typeof msg.epoch === "string") entry.epoch = msg.epoch;
            if (msg.seat === "red" || msg.seat === "yellow") entry.seat = msg.seat;
            entry.log = mergeLog(entry.log, msg);
            applyRing(entry);
            break;
          case "appended":
            if (msg.index === entry.log.length) {
              entry.log.push(msg.event);
              applyRing(entry);
            } else if (msg.index > entry.log.length) {
              entry.socket.send(
                JSON.stringify({
                  type: "resync",
                  have: entry.log.length,
                  epoch: entry.epoch,
                }),
              );
            }
            break;
          case "log":
            if (typeof msg.epoch === "string") entry.epoch = msg.epoch;
            entry.log = mergeLog(entry.log, msg);
            applyRing(entry);
            break;
          default:
            break;
        }
      });
      socket.addEventListener("close", (e) => {
        clearTimeout(connectTimeout);
        // The ring is derived exclusively from the event log by
        // applyRing() — never set directly by lifecycle events, so a
        // transient disconnect (DO restart, network blip) can't make
        // it flicker. If the game state actually changed while we
        // were offline, the next welcome/log will correct it.
        // Don't resurrect games the user removed from the list.
        if (live.has(entry.code)) {
          // Exponential backoff, so a downed server isn't hammered once
          // per in-progress game every few seconds.
          const backoff = entry.backoff ?? RING_RETRY_MIN_MS;
          const delay = e.code === 1013 ? OVERLOADED_RETRY_MS : backoff;
          entry.backoff = Math.min(backoff * 2, RING_RETRY_MAX_MS);
          setTimeout(() => {
            // Never stack a second socket onto a live one: the retry
            // only fires after this socket closed, but the visibility
            // handler may have already reconnected in the meantime.
            if (
              live.has(entry.code) &&
              (!entry.socket || entry.socket.readyState === WebSocket.CLOSED)
            ) {
              connectLanding(entry);
            }
          }, delay);
        }
      });
    }

    // Entries already carry `socket` and `lastAlive`, so they are what
    // the shared heartbeat wants to see.
    startHeartbeat(() => live.values());

    // A hidden tab's turn-rings are invisible, so its sockets are not
    // needed: close them, and reconnect everything on return. Mirrors
    // the game page's presence rule.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        for (const entry of live.values()) {
          if (entry.socket && entry.socket.readyState <= WebSocket.OPEN) entry.socket.close();
        }
        return;
      }
      for (const entry of live.values()) {
        // A fresh signal the network may be back: retry promptly rather
        // than inheriting a long delay from earlier trouble.
        entry.backoff = RING_RETRY_MIN_MS;
        if (!entry.socket || entry.socket.readyState === WebSocket.CLOSED) connectLanding(entry);
      }
    });

    for (const entry of live.values()) connectLanding(entry);

    /*
     * Removing a recent game. Briefly fade the row out, then drop it
     * from the DOM and delete its entry from the shared recent list in
     * local storage. The click can't reach the link (it's a separate
     * button), so navigation won't be triggered by a remove. The live
     * socket is also closed so it stops reporting presence.
     */
    function removeRecent(code, item) {
      const entry = live.get(code);
      if (entry && entry.socket) entry.socket.close();
      live.delete(code);
      item.classList.add("removing");
      const done = () => {
        item.remove();
        const stored = store.get("four:recent", []);
        const updated = (Array.isArray(stored) ? stored : []).filter(
          (g) => g && g.code !== code,
        );
        store.set("four:recent", updated);
        if (updated.length === 0) $("recent").hidden = true;
      };
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) done();
      else setTimeout(done, ROW_FADE_MS);
    }
  }

  /* ---------------- game ---------------- */

  function initGame(code) {
    $("game").hidden = false;

    const boardEl = $("board");
    const nameEl = $("game-name");
    const statusEl = $("status");
    const scoreEl = $("score");
    const shareBtn = $("share");
    const rematchBtn = $("rematch");

    let ws = null;
    let connected = false;
    let seat = null; // "red" | "yellow" | "spectator" | null before welcome
    let gameName = null; // server-stored name; the code stands in until set
    let queuedName = null; // rename typed while offline; sent on next welcome
    let log = [];
    let epoch = null; // log generation from the server; guards delta sync
    let presence = { red: false, yellow: false };
    let pending = false; // an append is in flight; wait for its broadcast
    let pendingStamp = 0;
    let resyncing = false; // a resync is in flight; don't ask again
    let backoff = 1000;
    let reconnectTimer = null;
    let lastAlive = Date.now(); // last time any frame arrived on the socket

    // Clearing the moment clears it for everyone at this game — either
    // player can do it, for both of them and every spectator. A
    // spectator's own click only clears their screen; a signal relayed
    // back would just bounce around the room.
    const celebration = createCelebration(boardEl, () => {
      if (seat === "red" || seat === "yellow") send({ type: "signal", name: "dismiss" });
    });
    let celebratedRound = null; // the round whose ending we've already played
    let celebrateTimer = null;

    // Iterating on the celebration otherwise means two browsers and a
    // full game per attempt. From the console: fourCelebrate("win"),
    // ("loss") or ("draw"). Local only — it sends no dismiss signal.
    window.fourCelebrate = (kind) => celebration.play(CELEBRATIONS[kind] || CELEBRATIONS.win);

    connect();
    render();

    function connect() {
      // A hidden tab is a player who isn't looking at the game: don't
      // connect (or reconnect) until the tab is visible again — the
      // visibilitychange handler reconnects on return.
      if (document.hidden) return;
      const socket = new WebSocket(socketUrl(code));
      ws = socket;
      // A bad network can leave a socket stuck CONNECTING for a long
      // time; give up so the close handler schedules the retry.
      const connectTimeout = setTimeout(() => {
        if (socket.readyState === WebSocket.CONNECTING) socket.close();
      }, CONNECT_TIMEOUT_MS);
      socket.addEventListener("open", () => {
        clearTimeout(connectTimeout);
        backoff = RETRY_MIN_MS;
        lastAlive = Date.now();
        send({ type: "hello", playerId: playerId(), have: log.length, epoch });
      });
      socket.addEventListener("message", (e) => {
        lastAlive = Date.now();
        if (e.data === "pong") return; // heartbeat reply, not JSON
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        handle(msg);
      });
      socket.addEventListener("close", () => {
        clearTimeout(connectTimeout);
        if (ws !== socket) return; // superseded by a newer connection
        connected = false;
        pending = false;
        resyncing = false;
        presence = { red: false, yellow: false };
        render();
        // Jittered, so two clients dropped by the same outage don't
        // come back in lockstep.
        reconnectTimer = setTimeout(connect, backoff * (0.5 + Math.random()));
        backoff = Math.min(backoff * 2, RETRY_MAX_MS);
      });
    }

    // Read at each tick rather than captured: `ws` is replaced on every
    // reconnect, and `lastAlive` moves with every frame.
    startHeartbeat(() => [{ socket: ws, lastAlive }]);

    // The instant the network returns or the tab wakes, don't sit out
    // the backoff timer — and probe a socket that may have died while
    // the tab was suspended.
    function reconnectNow() {
      if (ws && ws.readyState === WebSocket.OPEN) {
        lastAlive = Math.max(lastAlive, Date.now() - WAKE_GRACE_MS);
        ws.send("ping");
        return;
      }
      if (ws && ws.readyState === WebSocket.CONNECTING) {
        backoff = RETRY_MIN_MS; // attempt underway; if it's stale, retry fast
        return;
      }
      clearTimeout(reconnectTimer);
      backoff = RETRY_MIN_MS;
      connect();
    }
    // Belt and suspenders: iOS fires these inconsistently (Control
    // Center doesn't even hide the page), so hook every wake signal —
    // reconnectNow is idempotent, duplicates are harmless.
    addEventListener("online", reconnectNow);
    addEventListener("focus", reconnectNow);
    addEventListener("pageshow", reconnectNow);
    document.addEventListener("visibilitychange", () => {
      // Hiding the tab (switching tabs/apps, minimizing) means the
      // player isn't at the game: close the socket so the server marks
      // them away, exactly like clicking Leave. Returning reconnects.
      if (document.hidden) {
        // Close a still-CONNECTING socket too; the 10s connect timeout
        // would get it eventually, but there's no need to wait.
        if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
        return;
      }
      reconnectNow();
    });

    function send(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    }

    function requestResync() {
      if (resyncing) return;
      resyncing = true;
      send({ type: "resync", have: log.length, epoch });
    }

    /** Apply a welcome/log payload, epoch included. See mergeLog(). */
    function applyLog(msg) {
      if (typeof msg.epoch === "string") epoch = msg.epoch;
      log = mergeLog(log, msg);
    }

    function handle(msg) {
      switch (msg.type) {
        case "welcome":
          connected = true;
          seat = msg.seat;
          gameName = typeof msg.name === "string" ? msg.name : null;
          applyLog(msg);
          presence = { red: !!(msg.presence && msg.presence.red), yellow: !!(msg.presence && msg.presence.yellow) };
          pending = false;
          resyncing = false;
          if (queuedName) {
            send({ type: "set_name", name: queuedName });
            queuedName = null;
          }
          rememberRecent();
          render();
          break;
        case "name":
          if (typeof msg.name === "string") {
            gameName = msg.name;
            rememberRecent();
            render();
          }
          break;
        case "appended":
          if (msg.index === log.length) {
            log.push(msg.event);
            pending = false;
            rememberRecent();
            render(true); // animate just this event
          } else if (msg.index > log.length) {
            requestResync(); // we missed events
          } // behind: duplicate, ignore
          break;
        case "log":
          applyLog(msg);
          pending = false;
          resyncing = false;
          rememberRecent();
          render();
          break;
        case "rejected":
          pending = false;
          // Resync only if actually behind — when the winning append's
          // broadcast already caught us up, a refetch is wasted bytes.
          if (msg.reason === "index_mismatch" && msg.expectedIndex !== log.length) {
            requestResync();
          } else {
            render();
          }
          break;
        case "presence":
          presence = { red: !!msg.red, yellow: !!msg.yellow };
          render();
          break;
        case "signal":
          // Someone at this game cleared the end-of-round moment.
          if (msg.name === "dismiss") clearCelebration();
          break;
        default:
          break; // unknown types are ignored — forward-compatibility rule
      }
    }

    // Called from the handlers that change what's worth remembering
    // (welcome/appended/log/name), not from render — a presence blip
    // shouldn't cost a localStorage write.
    function rememberRecent() {
      if (!seat) return;
      const state = derive(log);
      const stored = store.get("four:recent", []);
      const recent = (Array.isArray(stored) ? stored : []).filter(
        (g) => g && g.code !== code,
      );
      recent.unshift({
        code,
        seat,
        name: gameName,
        done: !!state.over, // current round finished — unfinished games get flagged
        last: Date.now(),
      });
      store.set("four:recent", recent.slice(0, RECENT_LIMIT));
    }

    function tryAppend(event) {
      if (pending || !connected) return;
      pending = true;
      send({ type: "append", index: log.length, event });
      // If neither the broadcast nor a rejection ever lands, don't stay
      // frozen — ask for the log; its reply clears `pending` either way.
      const stamp = ++pendingStamp;
      setTimeout(() => {
        if (pending && pendingStamp === stamp) requestResync();
      }, APPEND_TIMEOUT_MS);
      render(); // drop ghost/cursor affordances while in flight
    }

    /* ---------- rendering ---------- */

    function render(animate) {
      const state = derive(log);
      renderName();
      renderScore(state);
      renderStatus(state);
      renderBoard(state, animate);
      rematchBtn.hidden = !(
        state.over && connected && (seat === "red" || seat === "yellow")
      );
      maybeCelebrate(state, animate);
    }

    /*
     * The end-of-round moment, once per round, and only when the round
     * ends live in front of you — `animate` marks an event that just
     * arrived. Opening or resyncing a finished game replays the board
     * but never the celebration; otherwise every refresh would set it
     * off again, and an async player would be met by a trophy for a
     * round that ended yesterday.
     */
    function maybeCelebrate(state, animate) {
      if (!state.over) {
        // A rematch (yours or theirs) clears the board underneath.
        celebratedRound = null;
        clearCelebration();
        return;
      }
      if (!animate || celebratedRound === state.round) return;
      celebratedRound = state.round;

      let spec;
      if (state.over.winner === null) spec = CELEBRATIONS.draw;
      else if (state.over.winner === seat) spec = CELEBRATIONS.win;
      else if (seat === "red" || seat === "yellow") spec = CELEBRATIONS.loss;
      // A spectator didn't lose — they watched somebody win, so they
      // get the win, retitled to name whose it was.
      else spec = { ...CELEBRATIONS.win, title: cap(state.over.winner) + " wins" };

      clearTimeout(celebrateTimer);
      celebrateTimer = setTimeout(() => celebration.play(spec), CELEBRATE_DELAY_MS);
    }

    /** Clear the moment, including one that hasn't opened yet. */
    function clearCelebration() {
      clearTimeout(celebrateTimer);
      celebration.dismiss();
    }

    /*
     * The game name in the HUD. Everyone sees it (code until named);
     * the creator (red) can click it to rename. While the input is
     * open, renders leave it alone so a presence blip doesn't eat a
     * half-typed name.
     */
    function renderName() {
      if (nameEl.querySelector("input")) return;
      nameEl.textContent = "";
      const display = gameName || code;
      if (connected && seat === "red") {
        const btn = el("button", "name-edit", display);
        btn.title = "Rename this game";
        btn.addEventListener("click", editName);
        nameEl.append(btn);
      } else {
        nameEl.append(el("span", null, display));
      }
    }

    function editName() {
      nameEl.textContent = "";
      const input = el("input", "name-input");
      input.value = gameName || "";
      input.placeholder = code;
      input.maxLength = MAX_NAME;
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") input.blur();
        if (e.key === "Escape") {
          input.value = gameName || "";
          input.blur();
        }
      });
      input.addEventListener("blur", () => {
        const name = input.value.trim();
        if (name && name !== gameName) {
          // The socket can die while the input is open; a rename typed
          // offline is queued and sent on the next welcome.
          if (connected && ws && ws.readyState === WebSocket.OPEN) {
            send({ type: "set_name", name });
          } else {
            queuedName = name;
          }
        }
        nameEl.textContent = "";
        renderName();
      });
      nameEl.append(input);
      input.focus();
      input.select();
    }

    function renderScore(state) {
      scoreEl.textContent = "";
      const redChip = el("span", "chip red" + (presence.red ? " on" : ""));
      const yellowChip = el("span", "chip yellow" + (presence.yellow ? " on" : ""));
      if (seat === "red") redChip.classList.add("you");
      if (seat === "yellow") yellowChip.classList.add("you");
      if (seat === "red" || seat === "yellow") {
        (seat === "red" ? redChip : yellowChip).title = "You";
      }
      if (seat !== "red") redChip.title = presence.red ? "Red is here" : "Red is away";
      if (seat !== "yellow") yellowChip.title = presence.yellow ? "Yellow is here" : "Yellow is away";
      scoreEl.append(
        redChip,
        document.createTextNode(` ${state.score.red} — ${state.score.yellow} `),
        yellowChip,
      );
    }

    function renderStatus(state) {
      statusEl.textContent = "";
      let text;
      if (!connected) {
        text = "Connecting…";
      } else if (state.over) {
        if (state.over.winner === null) text = "Draw";
        else if (seat === state.over.winner) text = "You win this round";
        else text = cap(state.over.winner) + " wins this round";
      } else if (seat === "spectator") {
        text = "Watching · " + cap(state.turn) + " to move";
      } else {
        text = state.turn === seat ? "Your turn" : cap(state.turn) + "’s turn";
      }
      statusEl.append(el("span", null, text));

      if (!connected || !seat) return;
      // One dot for everyone: colored by whoever's turn it is; grey
      // (base) when that player is away. Presence shows on the
      // scoreboard chips' pulse instead.
      const turn = state.turn;
      if (turn === "red" || turn === "yellow") {
        const dot = el("span", "dot " + turn + (presence[turn] ? " on" : ""));
        dot.title = cap(turn) + " to move" + (presence[turn] ? " · here" : " · away");
        statusEl.append(dot);
      } else {
        const dot = el("span", "dot");
        dot.title = "Round over";
        statusEl.append(dot);
      }
    }

    function renderBoard(state, animate) {
      boardEl.textContent = "";
      const myTurn =
        connected &&
        !pending &&
        !state.over &&
        (seat === "red" || seat === "yellow") &&
        state.turn === seat;

      for (let c = 0; c < 7; c++) {
        const colEl = el("div", "col");
        const landing = dropRow(state.board, c);
        const playable = myTurn && landing >= 0;
        if (playable) {
          colEl.classList.add("playable");
          colEl.tabIndex = 0;
          colEl.setAttribute("role", "button");
          colEl.setAttribute("aria-label", "Drop in column " + (c + 1));
          const drop = () => tryAppend({ kind: "move", col: c });
          colEl.addEventListener("click", drop);
          colEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              drop();
            }
          });
        }
        for (let r = 5; r >= 0; r--) {
          const cell = el("div", "cell");
          const occupant = state.board[r][c];
            if (occupant) {
              const piece = el("div", "piece " + occupant);
              if (state.over && state.over.cells.some(([wr, wc]) => wr === r && wc === c)) {
                piece.classList.add("win");
              }
              const isLast =
                state.lastMove && state.lastMove.row === r && state.lastMove.col === c;
              if (isLast && !animate) piece.classList.add("last");
              if (animate && isLast) {
                const rowsFromTop = 5 - r;
                piece.style.setProperty(
                  "--fall",
                  `calc(${rowsFromTop + 1} * var(--cell) * -1)`,
                );
                piece.style.animationDuration = 150 + rowsFromTop * 25 + "ms";
                piece.classList.add("drop");
                // `last` is added only once the fall ends: both classes set the
                // `animation` shorthand, so on one element the later rule would
                // win the shorthand and cancel the fall. The inline duration
                // set for the fall must also be dropped so the stylesheet's
                // pulse duration applies once we switch over.
                piece.addEventListener(
                  "animationend",
                  () => {
                    piece.style.animationDuration = "";
                    piece.classList.add("last");
                  },
                  { once: true },
                );
              }
              cell.append(piece);
            } else if (playable && r === landing) {
            cell.append(el("div", "piece ghost " + seat));
          }
          colEl.append(cell);
        }
        boardEl.append(colEl);
      }
    }

    /* ---------- actions ---------- */

    shareBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(location.href);
        shareBtn.textContent = "Copied ✓";
        setTimeout(() => (shareBtn.textContent = "Copy link"), 1500);
      } catch {
        prompt("Copy the game link:", location.href);
      }
    });

    rematchBtn.addEventListener("click", () => tryAppend({ kind: "new_round" }));

    // A tap on the board while disconnected is a fine reason to retry
    // right now instead of waiting out the backoff timer.
    boardEl.addEventListener("click", () => {
      if (!connected) reconnectNow();
    });

    $("leave").addEventListener("click", () => {
      location.href = "/";
    });
  }
}

/* ================================================================
 * Celebration — the end-of-round moment.
 *
 * One full-viewport layer, back to front: a black scrim, a canvas of
 * settled paint, a canvas of paint still in flight, the verdict, and
 * an emoji centered on the board.
 *
 * The game code picks a spec and says "play". Everything else — the
 * DOM, the animation loop, the sizing, the teardown — lives in here.
 * The one thing that comes back out is `onUserDismiss`, called when
 * this viewer clears the layer themselves, so the caller can tell the
 * rest of the game about it.
 *
 * The splatter effect is our own canvas implementation, inspired by
 * confetti.ts by LoaderB0T (MIT) — https://github.com/LoaderB0T/confetti.ts
 * — but shares no code with it: this project ships zero third-party
 * assets, and a splat here is a closed-form ease rather than a
 * per-frame physics step.
 * ================================================================ */

/**
 * What each outcome plays. `entrance` names the emoji's arrival (a
 * matching `entrance-*` class drives it from the stylesheet), `dim` is
 * the opacity of the black scrim behind it, and `splatter` is the
 * paint. Winning keeps a lighter scrim than the other two: the paint
 * lands in front of it and wants a ground to read against, not a
 * blackout.
 *
 * `title` is the default; a spectator's is built at play time, since
 * nobody watching a game they aren't in has won or lost anything.
 */
const CELEBRATIONS = {
  win: { title: "You win", emoji: "🏆", entrance: "grow", splatter: true, dim: 0.5 },
  loss: { title: "You lose", emoji: "😞", entrance: "drop", splatter: false, dim: 0.85 },
  draw: { title: "Draw", emoji: "🤝", entrance: "slam", splatter: false, dim: 0.85 },
};

// Just long enough for the winning piece to land — the paint should
// read as starting with the win, not as a beat after it.
const CELEBRATE_DELAY_MS = 280;

function createCelebration(boardEl, onUserDismiss) {
  // Bright enough to read on either theme, and spread far enough
  // around the hue circle that three random picks rarely look like one
  // color. Indexed, not named: dots store the index so the dissolve can
  // batch thousands of them into a handful of fills.
  const PALETTE = [
    "oklch(63% 0.22 27)", // red
    "oklch(72% 0.19 55)", // orange
    "oklch(84% 0.17 95)", // yellow
    "oklch(74% 0.20 145)", // green
    "oklch(74% 0.14 195)", // teal
    "oklch(62% 0.19 258)", // blue
    "oklch(58% 0.24 300)", // violet
    "oklch(68% 0.23 350)", // pink
  ];

  // A splat's dots ease out to their resting distance and then never
  // move again — this is paint, not confetti. ~99% of the way by 5τ.
  const SETTLE_TAU = 110;
  const SETTLE_MS = 620;

  // Splats per second. The rate climbs for the whole build so the
  // field reads as still gathering pace, never as having levelled off.
  const RATE_START = 9;
  const RATE_END = 34;
  const RAMP_MS = 3000;
  // How fast the splats stop keeping to the top half and start landing
  // anywhere — quick, so it matches the emoji finishing its growth.
  const REGION_MS = 1200;
  // The paint budget for the whole show, set from the viewport in
  // measure(): one dot per this many CSS pixels of screen, so a phone
  // gets the same density as a desktop rather than the same count.
  // Accumulated paint costs nothing per frame — the ceiling is here
  // because the dissolve is the one pass that redraws every dot, and
  // that is the machine-dependent part.
  const PIXELS_PER_DOT = 142;
  const DOTS_FLOOR = 1800;
  const DOTS_CEILING = 4300;
  let maxDots = DOTS_CEILING;
  // Backstop, in case a viewport is big enough that the cap never lands.
  const SPAWN_MS = 9000;

  // Dissolve: every dot goes out on its own schedule, so the field
  // comes apart rather than blinking off as one sheet.
  const STAGGER_MS = 280;
  const DOT_FADE_MS = 170;
  const OUT_MS = STAGGER_MS + DOT_FADE_MS;
  // An emoji-only ending has no paint to dissolve; it just waits out
  // the stylesheet's fade.
  const PLAIN_OUT_MS = 240;

  // Alpha is quantized during the dissolve so a few thousand dots
  // collapse into (steps × colors) filled paths per frame.
  const ALPHA_STEPS = 6;
  const TWO_PI = Math.PI * 2;

  let layer = null;
  let dimEl = null;
  let titleEl = null;
  let emojiEl = null;
  // Settled paint. Drawn into once per splat and never cleared during
  // the show, so accumulated paint costs nothing per frame.
  let paint = null;
  let paintCtx = null;
  // Splats still expanding. Cleared and redrawn every frame — only
  // ever a handful.
  let fly = null;
  let flyCtx = null;

  let flying = []; // splats mid-expansion
  let pendingDots = 0; // dots the splats still flying will add to `dots`
  // Every droplet laid down: an ellipse { x, y, rx, ry, rot }, a palette
  // index `ci`, and `d`, its place in the dissolve queue.
  let dots = [];
  let centers = []; // splat centers so far, for spacing the next one
  let buckets = []; // reused dissolve draw buckets: [alphaStep][colorIndex]

  let raf = 0;
  let startedAt = 0;
  let lastFrame = 0;
  let owed = 0; // fractional splats carried between frames
  let closing = false;
  let closedAt = 0;
  let closeTimer = null;
  let w = 0;
  let h = 0;

  function build() {
    layer = document.createElement("div");
    layer.className = "celebration";
    // Decorative: the status line already announces the result.
    layer.setAttribute("aria-hidden", "true");

    dimEl = document.createElement("div");
    dimEl.className = "celebration-dim";
    paint = document.createElement("canvas");
    paint.className = "celebration-canvas";
    fly = document.createElement("canvas");
    fly.className = "celebration-canvas";
    titleEl = document.createElement("span");
    titleEl.className = "celebration-title";
    emojiEl = document.createElement("span");
    emojiEl.className = "celebration-emoji";

    layer.append(dimEl, paint, fly, titleEl, emojiEl);
    paintCtx = paint.getContext("2d");
    flyCtx = fly.getContext("2d");
    layer.addEventListener("pointerdown", userDismiss);

    for (let step = 0; step < ALPHA_STEPS; step++) {
      buckets.push(PALETTE.map(() => []));
    }
  }

  function measure() {
    w = window.innerWidth;
    h = window.innerHeight;
    maxDots = Math.max(
      DOTS_FLOOR,
      Math.min(Math.round((w * h) / PIXELS_PER_DOT), DOTS_CEILING),
    );
    // Cap the backing store at 2x: past that a phone pays for pixels
    // nobody can see in a field of 3px dots.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const [canvas, context] of [[paint, paintCtx], [fly, flyCtx]]) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    // Resizing blanks the backing store, so the settled paint has to be
    // laid down again. Dots keep their absolute positions — paint on a
    // wall doesn't reflow when the window changes shape.
    repaint();
    place();
  }

  /**
   * Center the emoji on the board, wherever the layout has put it, and
   * hang the title above it. Both are sized here rather than in the
   * stylesheet because both depend on the board — and on each other,
   * since the title has to fit in whatever room the emoji leaves.
   */
  function place() {
    const rect = boardEl.getBoundingClientRect();
    // Viewport height bounds the emoji too: a short landscape phone
    // would otherwise fill the screen and leave the title nowhere.
    const size = Math.max(
      101,
      Math.min(rect.width * 0.72, window.innerHeight * 0.34, 288),
    );
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    emojiEl.style.left = centerX + "px";
    emojiEl.style.top = centerY + "px";
    emojiEl.style.setProperty("--size", size + "px");
    // The grow starts at 12px, whatever the finished size works out to.
    emojiEl.style.setProperty("--from", (12 / size).toFixed(4));
    // The drop starts fully above the viewport, so it enters from off
    // screen however tall the window is or wherever the board sits.
    emojiEl.style.setProperty("--drop", centerY + size + "px");
    emojiEl.style.setProperty("--bounce", size * 0.06 + "px");

    // The title takes the largest size that clears the emoji, spans no
    // more than the viewport, and stays under a sane ceiling — the
    // width term is why "Yellow wins" on a narrow phone comes out
    // smaller than "Draw" does.
    const gap = Math.max(18, size * 0.12);
    const bottom = centerY - size / 2 - gap;
    const budget = window.innerWidth * 0.92;
    const chars = Math.max(4, titleEl.textContent.length);
    const titleSize = Math.max(
      24,
      Math.min(
        budget / (chars * 0.52), // across, optimistically — corrected below
        (bottom - 12) / 1.15, // above the emoji, leaving a top margin
        window.innerHeight * 0.13,
        96,
      ),
    );
    titleEl.style.left = centerX + "px";
    titleEl.style.top = bottom + "px";
    titleEl.style.setProperty("--title-size", titleSize + "px");

    // Character counting only estimates a proportional font's width, so
    // measure what actually rendered and scale back if the glyphs came
    // out wider than the budget. Exact beats guessing, and it means the
    // guess above can afford to be generous.
    const actual = titleEl.offsetWidth;
    if (actual > budget) {
      titleEl.style.setProperty("--title-size", (titleSize * budget) / actual + "px");
    }
  }

  /** Lay every settled dot back down, one filled path per color. */
  function repaint() {
    paintCtx.clearRect(0, 0, w, h);
    for (let ci = 0; ci < PALETTE.length; ci++) {
      let drew = false;
      paintCtx.fillStyle = PALETTE[ci];
      paintCtx.beginPath();
      for (const dot of dots) {
        if (dot.ci !== ci) continue;
        drew = true;
        blob(paintCtx, dot.x, dot.y, dot.rx, dot.ry, dot.rot);
      }
      if (drew) paintCtx.fill();
    }
  }

  /**
   * One droplet inside a batched path — an ellipse, not a circle:
   * thrown paint stretches along its flight, and a field of perfect
   * circles reads as dots rather than splatter. Costs the same as an
   * arc and batches identically.
   *
   * The moveTo is not optional, and has to land on the ellipse's own
   * start point: without it each shape joins the previous one and the
   * whole path fills as a web of connecting lines.
   */
  function blob(context, x, y, rx, ry, rot) {
    context.moveTo(x + rx * Math.cos(rot), y + rx * Math.sin(rot));
    context.ellipse(x, y, rx, ry, rot, 0, TWO_PI);
  }

  /**
   * Where the next splat lands. Uniform random clumps and leaves bald
   * patches; taking the farthest of a few candidates from the paint
   * already down spreads the field over the whole viewport without
   * ever looking like it was laid out on a grid.
   */
  function pickSpot(region) {
    // Centers stay off the edges, though the paint itself may bleed past.
    const pad = Math.min(w, h) * 0.1;
    const band = h * (0.5 + 0.5 * region); // top half at first, all of it later
    let best = null;
    let bestGap = -1;
    for (let i = 0; i < 3; i++) {
      const x = pad + Math.random() * Math.max(1, w - pad * 2);
      const y = pad + Math.random() * Math.max(1, band - pad * 2);
      let gap = Infinity;
      for (const other of centers) {
        const dx = other.x - x;
        const dy = other.y - y;
        gap = Math.min(gap, dx * dx + dy * dy);
      }
      if (gap > bestGap) {
        bestGap = gap;
        best = { x, y };
      }
    }
    return best;
  }

  function spawn(now, region) {
    const { x, y } = pickSpot(region);
    centers.push({ x, y });

    const size = Math.min(w, h);
    const reach = size * (0.11 + Math.random() * 0.14);
    // Dots scale with the viewport so a phone doesn't get a coarser
    // splat than a desktop.
    const grain = Math.min(1.35, Math.max(0.7, size / 720));
    const count = 24 + Math.floor(Math.random() * 15);

    // Three colors per splat, dots bucketed by color at birth, so
    // drawing one mid-flight splat is three filled paths.
    const groups = [
      { ci: Math.floor(Math.random() * PALETTE.length), pts: [] },
      { ci: Math.floor(Math.random() * PALETTE.length), pts: [] },
      { ci: Math.floor(Math.random() * PALETTE.length), pts: [] },
    ];
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * TWO_PI;
      // Biased outward so the splat has a dense middle and a few fliers.
      const distance = reach * Math.pow(Math.random(), 0.55);
      const r = (1.3 + Math.pow(Math.random(), 2) * 3.6) * grain;
      // The further a droplet was thrown the more it stretches, and
      // most stay near-round — a field where every dot is elongated
      // looks combed rather than splattered. `stretch` is the long/short
      // axis ratio, so this tops out at a gentle 2:1 with the typical
      // droplet nearer 1.2:1. Area is held constant, so shape changes
      // without coverage changing with it.
      const stretch = 1 + (distance / reach) * Math.pow(Math.random(), 1.5) * 1.0;
      const skew = Math.sqrt(stretch);
      groups[i % 3].pts.push({
        dx: Math.cos(angle) * distance,
        dy: Math.sin(angle) * distance,
        rx: r * skew,
        ry: r / skew,
        // Along the flight path, loosened a little so the field doesn't
        // read as a starburst of perfectly radial strokes.
        rot: angle + (Math.random() - 0.5) * 0.7,
      });
    }
    pendingDots += count;
    // Born on the frame's clock, not performance.now(): the frame
    // timestamp trails the real one, and a splat born "in the future"
    // reads as a negative age and briefly implodes instead of bursting.
    flying.push({ x, y, born: now, count, groups });
  }

  /**
   * Move a splat off the live list and into the settled paint. `spread`
   * is where its dots have got to (1 once it has finished): dismissing
   * mid-burst has to freeze them where they are, or a splat that is
   * 100ms old snaps to full size on the way out.
   */
  function settle(splat, spread) {
    pendingDots -= splat.count;
    for (const group of splat.groups) {
      paintCtx.fillStyle = PALETTE[group.ci];
      paintCtx.beginPath();
      for (const pt of group.pts) {
        const x = splat.x + pt.dx * spread;
        const y = splat.y + pt.dy * spread;
        blob(paintCtx, x, y, pt.rx, pt.ry, pt.rot);
        // `d` is this dot's place in the dissolve queue, fixed now so
        // the order is scattered rather than following the paint order.
        dots.push({ x, y, rx: pt.rx, ry: pt.ry, rot: pt.rot, ci: group.ci, d: Math.random() });
      }
      paintCtx.fill();
    }
  }

  function spawning(age) {
    return age < SPAWN_MS && dots.length + pendingDots < maxDots;
  }

  function advance(now, age, dt) {
    if (spawning(age)) {
      const rate = RATE_START + (RATE_END - RATE_START) * Math.min(1, age / RAMP_MS);
      const region = Math.min(1, age / REGION_MS);
      owed += rate * (dt / 1000);
      while (owed >= 1 && spawning(age)) {
        owed -= 1;
        spawn(now, region);
      }
      owed = Math.min(owed, 1); // never bank a backlog that dumps as one burst
    }

    flyCtx.clearRect(0, 0, w, h);
    let live = 0;
    for (let i = 0; i < flying.length; i++) {
      const splat = flying[i];
      const splatAge = now - splat.born;
      if (splatAge >= SETTLE_MS) {
        settle(splat, 1);
        continue;
      }
      flying[live++] = splat;
      const spread = 1 - Math.exp(-splatAge / SETTLE_TAU);
      for (const group of splat.groups) {
        flyCtx.fillStyle = PALETTE[group.ci];
        flyCtx.beginPath();
        for (const pt of group.pts) {
          blob(flyCtx, splat.x + pt.dx * spread, splat.y + pt.dy * spread, pt.rx, pt.ry, pt.rot);
        }
        flyCtx.fill();
      }
    }
    flying.length = live;
  }

  /** The dissolve: each dot fades on its own clock, staggered by `d`. */
  function dissolve(now) {
    const t = now - closedAt;
    for (const row of buckets) {
      for (const bucket of row) bucket.length = 0;
    }
    for (const dot of dots) {
      const alpha = 1 - (t - dot.d * STAGGER_MS) / DOT_FADE_MS;
      if (alpha <= 0) continue;
      const step = alpha >= 1 ? ALPHA_STEPS - 1 : Math.floor(alpha * ALPHA_STEPS);
      buckets[step][dot.ci].push(dot);
    }

    paintCtx.clearRect(0, 0, w, h);
    for (let step = 0; step < ALPHA_STEPS; step++) {
      paintCtx.globalAlpha = (step + 1) / ALPHA_STEPS;
      for (let ci = 0; ci < PALETTE.length; ci++) {
        const bucket = buckets[step][ci];
        if (bucket.length === 0) continue;
        paintCtx.fillStyle = PALETTE[ci];
        paintCtx.beginPath();
        for (const dot of bucket) blob(paintCtx, dot.x, dot.y, dot.rx, dot.ry, dot.rot);
        paintCtx.fill();
      }
    }
    paintCtx.globalAlpha = 1;
  }

  function frame(now) {
    // Clamped both ways: a backgrounded tab resumes with a huge gap,
    // and the first frame's timestamp can trail the play() call that
    // set the clock.
    const dt = Math.max(0, Math.min(50, now - lastFrame));
    lastFrame = now;

    if (closing) {
      dissolve(now);
      if (now - closedAt >= OUT_MS) {
        teardown();
        return;
      }
    } else {
      const age = now - startedAt;
      advance(now, age, dt);
      // Once the paint is down and nothing is in flight the picture is
      // finished: stop the loop entirely rather than redrawing a static
      // field until someone clicks. The canvas keeps what it holds.
      if (!spawning(age) && flying.length === 0) {
        raf = 0;
        return;
      }
    }
    raf = requestAnimationFrame(frame);
  }

  function onKey(e) {
    if (e.key !== "Escape" && e.key !== "Enter" && e.key !== " ") return;
    // Capture and swallow: a board column can still hold focus behind
    // the layer, and Enter there would drop a piece instead of
    // dismissing.
    e.preventDefault();
    e.stopPropagation();
    userDismiss();
  }

  function teardown() {
    cancelAnimationFrame(raf);
    raf = 0;
    clearTimeout(closeTimer);
    closeTimer = null;
    flying = [];
    dots = [];
    centers = [];
    pendingDots = 0;
    owed = 0;
    closing = false;
    window.removeEventListener("resize", measure);
    window.removeEventListener("keydown", onKey, true);
    if (layer) layer.remove();
  }

  /**
   * Dismissal the local viewer asked for, as opposed to one arriving
   * from the other end of the game. Only this path reports back — a
   * relayed dismissal that echoed would bounce between clients.
   */
  function userDismiss() {
    if (dismiss() && onUserDismiss) onUserDismiss();
  }

  /** Returns whether there was anything to dismiss. */
  function dismiss() {
    if (!layer || !layer.isConnected || closing) return false;
    closing = true;
    closedAt = performance.now();
    // `lit` comes off as `out` goes on: the entrance rules are keyed on
    // it, and while they match they outrank the exit rules and the
    // arrival animation would go on holding the emoji in place.
    layer.classList.remove("lit");
    layer.classList.add("out");

    // Anything still in flight joins the paint where it currently is,
    // so the dissolve accounts for every dot on screen.
    for (const splat of flying) {
      const splatAge = Math.min(SETTLE_MS, closedAt - splat.born);
      settle(splat, 1 - Math.exp(-Math.max(0, splatAge) / SETTLE_TAU));
    }
    flying.length = 0;
    if (flyCtx) flyCtx.clearRect(0, 0, w, h);

    if (dots.length === 0) {
      // Emoji-only ending: nothing to dissolve, just outlast the fade.
      cancelAnimationFrame(raf);
      raf = 0;
      closeTimer = setTimeout(teardown, PLAIN_OUT_MS);
      return true;
    }
    if (!raf) {
      lastFrame = closedAt;
      raf = requestAnimationFrame(frame);
    }
    return true;
  }

  return {
    play(spec) {
      if (layer && layer.isConnected) teardown(); // a new ending supersedes
      if (!layer) build();

      // Both set before measure(), which sizes the title from its text.
      titleEl.textContent = spec.title;
      emojiEl.textContent = spec.emoji;
      layer.style.setProperty("--dim", String(spec.dim));
      // `scrim` is what the title reads to know it is over black rather
      // than over the page, and so which color it has to be.
      layer.className =
        "celebration entrance-" + spec.entrance + (spec.dim > 0 ? " scrim" : "");
      document.body.append(layer);
      measure();
      window.addEventListener("resize", measure);
      window.addEventListener("keydown", onKey, true);
      // Next frame, so the animation and transitions run from their
      // start values instead of collapsing into the initial style.
      requestAnimationFrame(() => {
        if (layer && layer.isConnected) layer.classList.add("lit");
      });

      // Reduced motion keeps the emoji (it carries the meaning) and
      // drops the paint entirely.
      const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!spec.splatter || still) return;
      startedAt = performance.now();
      lastFrame = startedAt;
      // Prime the field so the first splats land on the opening frame
      // rather than a rate-interval later — the paint should start with
      // the win, not just after it.
      owed = 3;
      raf = requestAnimationFrame(frame);
    },

    /** Idempotent, and safe to call when nothing is playing. */
    dismiss,
  };
}
