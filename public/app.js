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

/* ================================================================ */

if (typeof module !== "undefined" && module.exports) {
  module.exports = { emptyBoard, dropRow, winFrom, derive, otherSeat };
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
      const scheme = location.protocol === "https:" ? "wss://" : "ws://";
      const socket = new WebSocket(scheme + location.host + "/g/" + entry.code + "/ws");
      entry.socket = socket;
      socket.addEventListener("open", () => {
        entry.lastAlive = Date.now();
        socket.send(
          JSON.stringify({
            type: "hello",
            playerId: playerId(),
            have: entry.log.length,
            epoch: entry.epoch,
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
            // Delta sync, same as the game client: when the hello's
            // have/epoch matched, welcome carries only the suffix.
            {
              const events = Array.isArray(msg.log) ? msg.log : [];
              const from = Number.isInteger(msg.from) ? msg.from : 0;
              if (from > 0 && from <= entry.log.length) {
                entry.log = entry.log.slice(0, from).concat(events);
              } else {
                entry.log = events;
              }
            }
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
            if (msg.from > 0 && msg.from <= entry.log.length) {
              entry.log = entry.log.slice(0, msg.from).concat(msg.log || []);
            } else {
              entry.log = Array.isArray(msg.log) ? msg.log : [];
            }
            applyRing(entry);
            break;
          default:
            break;
        }
      });
      socket.addEventListener("close", () => {
        // The ring is derived exclusively from the event log by
        // applyRing() — never set directly by lifecycle events, so a
        // transient disconnect (DO restart, network blip) can't make
        // it flicker. If the game state actually changed while we
        // were offline, the next welcome/log will correct it.
        // Don't resurrect games the user removed from the list.
        if (live.has(entry.code)) {
          setTimeout(() => {
            if (live.has(entry.code)) connectLanding(entry);
          }, 5000);
        }
      });
    }

    // Heartbeat like the game client: keeps sockets alive across idle and
    // detects dead ones so the retry above takes over.
    setInterval(() => {
      for (const entry of live.values()) {
        if (!entry.socket || entry.socket.readyState !== WebSocket.OPEN) continue;
        if (Date.now() - entry.lastAlive > 45000) entry.socket.close();
        else entry.socket.send("ping");
      }
    }, 20000);

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
      else setTimeout(done, 200);
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

    connect();
    render();

    function connect() {
      const scheme = location.protocol === "https:" ? "wss://" : "ws://";
      const socket = new WebSocket(scheme + location.host + "/g/" + code + "/ws");
      ws = socket;
      // A bad network can leave a socket stuck CONNECTING for a long
      // time; give up so the close handler schedules the retry.
      const connectTimeout = setTimeout(() => {
        if (socket.readyState === WebSocket.CONNECTING) socket.close();
      }, 10000);
      socket.addEventListener("open", () => {
        clearTimeout(connectTimeout);
        backoff = 1000;
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
        reconnectTimer = setTimeout(connect, backoff * (0.5 + Math.random()));
        // Low cap: an attempt is one cheap request, and iOS doesn't
        // reliably fire `online` — the timer is the recovery path there.
        backoff = Math.min(backoff * 2, 10000);
      });
    }

    /*
     * Heartbeat. TCP dies silently on flaky networks: the socket looks
     * OPEN while frames go nowhere. Ping over quiet stretches; a long
     * silence means the connection is dead — close it so the normal
     * reconnect path takes over. The server answers pings without
     * waking (auto-response), so idle games still cost nothing.
     */
    setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastAlive > 45000) ws.close();
      else ws.send("ping");
    }, 20000);

    // The instant the network returns or the tab wakes, don't sit out
    // the backoff timer — and probe a socket that may have died while
    // the tab was suspended.
    function reconnectNow() {
      if (ws && ws.readyState === WebSocket.OPEN) {
        // Grace so a stale timestamp from a suspended tab doesn't kill
        // a live socket before its pong lands.
        lastAlive = Math.max(lastAlive, Date.now() - 25000);
        ws.send("ping");
        return;
      }
      if (ws && ws.readyState === WebSocket.CONNECTING) {
        backoff = 1000; // attempt underway; if it's a stale one, retry fast
        return;
      }
      clearTimeout(reconnectTimer);
      backoff = 1000;
      connect();
    }
    // Belt and suspenders: iOS fires these inconsistently (Control
    // Center doesn't even hide the page), so hook every wake signal —
    // reconnectNow is idempotent, duplicates are harmless.
    addEventListener("online", reconnectNow);
    addEventListener("focus", reconnectNow);
    addEventListener("pageshow", reconnectNow);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) reconnectNow();
    });

    function send(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    }

    function requestResync() {
      if (resyncing) return;
      resyncing = true;
      send({ type: "resync", have: log.length, epoch });
    }

    /*
     * Apply a welcome/log payload. Delta sync: the server sends only
     * the events past what our hello/resync claimed to have (`from` is
     * the join point); from: 0 — epoch mismatch, old server, or a log
     * reset by expiry — replaces wholesale.
     */
    function applyLog(msg) {
      const events = Array.isArray(msg.log) ? msg.log : [];
      const from = Number.isInteger(msg.from) ? msg.from : 0;
      if (typeof msg.epoch === "string") epoch = msg.epoch;
      if (from > 0 && from <= log.length) log = log.slice(0, from).concat(events);
      else log = events;
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
      store.set("four:recent", recent.slice(0, 10));
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
      }, 8000);
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
      input.maxLength = 16;
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
