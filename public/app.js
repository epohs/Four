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
 * ended) are shrugged off, per the architecture doc.
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
      round++;
      board = emptyBoard();
      over = null;
      moves = 0;
      lastMove = null;
      continue;
    }
    if (ev.kind !== "move" || (ev.seat !== "red" && ev.seat !== "yellow")) continue;
    const row = dropRow(board, ev.col);
    if (over || row < 0) continue;
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
    for (const game of recent) {
      if (typeof game.code !== "string" || !/^[A-Za-z0-9_-]+$/.test(game.code)) continue;
      const item = el("li");
      const link = el("a");
      link.href = "/g/" + game.code;
      const seatClass = game.seat === "red" || game.seat === "yellow" ? game.seat : "spectator";
      link.append(
        el("span", "chip " + seatClass),
        el("code", null, game.code),
        el("time", null, game.last ? new Date(game.last).toLocaleDateString() : ""),
      );
      item.append(link);
      list.append(item);
    }
  }

  /* ---------------- game ---------------- */

  function initGame(code) {
    $("game").hidden = false;

    const boardEl = $("board");
    const statusEl = $("status");
    const scoreEl = $("score");
    const shareBtn = $("share");
    const rematchBtn = $("rematch");

    let ws = null;
    let connected = false;
    let seat = null; // "red" | "yellow" | "spectator" | null before welcome
    let log = [];
    let presence = { red: false, yellow: false };
    let pending = false; // an append is in flight; wait for its broadcast
    let backoff = 1000;

    connect();
    render();

    function connect() {
      const scheme = location.protocol === "https:" ? "wss://" : "ws://";
      ws = new WebSocket(scheme + location.host + "/g/" + code + "/ws");
      ws.addEventListener("open", () => {
        backoff = 1000;
        send({ type: "hello", playerId: playerId() });
      });
      ws.addEventListener("message", (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        handle(msg);
      });
      ws.addEventListener("close", () => {
        connected = false;
        pending = false;
        presence = { red: false, yellow: false };
        render();
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30000);
      });
    }

    function send(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    }

    function handle(msg) {
      switch (msg.type) {
        case "welcome":
          connected = true;
          seat = msg.seat;
          log = Array.isArray(msg.log) ? msg.log : [];
          presence = msg.presence;
          pending = false;
          rememberRecent();
          render();
          break;
        case "appended":
          if (msg.index === log.length) {
            log.push(msg.event);
            pending = false;
            render(true); // animate just this event
          } else if (msg.index > log.length) {
            send({ type: "resync" }); // we missed events
          } // behind: duplicate, ignore
          break;
        case "log":
          log = Array.isArray(msg.log) ? msg.log : [];
          pending = false;
          render();
          break;
        case "rejected":
          pending = false;
          if (msg.reason === "index_mismatch") send({ type: "resync" });
          else render();
          break;
        case "presence":
          presence = { red: !!msg.red, yellow: !!msg.yellow };
          render();
          break;
        default:
          break; // unknown types are ignored — forward-compatibility rule
      }
    }

    function rememberRecent() {
      const stored = store.get("four:recent", []);
      const recent = (Array.isArray(stored) ? stored : []).filter(
        (g) => g && g.code !== code,
      );
      recent.unshift({ code, seat, last: Date.now() });
      store.set("four:recent", recent.slice(0, 10));
    }

    function tryAppend(event) {
      if (pending || !connected) return;
      pending = true;
      send({ type: "append", index: log.length, event });
      render(); // drop ghost/cursor affordances while in flight
    }

    /* ---------- rendering ---------- */

    function render(animate) {
      const state = derive(log);
      renderScore(state);
      renderStatus(state);
      renderBoard(state, animate);
      rematchBtn.hidden = !(
        state.over && connected && (seat === "red" || seat === "yellow")
      );
    }

    function renderScore(state) {
      scoreEl.textContent = "";
      const redChip = el("span", "chip red");
      const yellowChip = el("span", "chip yellow");
      if (seat === "red") redChip.classList.add("you");
      if (seat === "yellow") yellowChip.classList.add("you");
      if (seat === "red" || seat === "yellow") {
        (seat === "red" ? redChip : yellowChip).title = "You";
      }
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
      // Presence: a player sees the opponent's dot; a spectator sees both.
      const dotsFor = seat === "spectator" ? ["red", "yellow"] : [otherSeat(seat)];
      for (const s of dotsFor) {
        const dot = el("span", "dot " + s + (presence[s] ? " on" : ""));
        dot.title = cap(s) + (presence[s] ? " is here" : " is away");
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
            if (
              animate &&
              state.lastMove &&
              state.lastMove.row === r &&
              state.lastMove.col === c
            ) {
              const rowsFromTop = 5 - r;
              piece.style.setProperty(
                "--fall",
                `calc(${rowsFromTop + 1} * var(--cell) * -1)`,
              );
              piece.style.animationDuration = 150 + rowsFromTop * 25 + "ms";
              piece.classList.add("drop");
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
  }
}
