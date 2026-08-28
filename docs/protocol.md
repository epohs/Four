# WebSocket Protocol

The contract between the vanilla-JS client and the TypeScript Durable Object. This document is the source of truth for the boundary (there are no shared type definitions), so implementation on either side follows it exactly.

All messages are JSON text frames.

## Connection

The client opens a WebSocket to:

```
wss://<host>/g/<code>/ws
```

The URL is derived from `location` at runtime — the host is never configured or hardcoded.

## Events (the stored things)

An **event** is what lives in the append-only log. Two kinds:

```jsonc
{ "kind": "move", "col": 3, "seat": "red" }   // col: 0–6; seat stamped by the server
{ "kind": "new_round" }
```

The server stamps `seat` on move events from the seat of the sending socket; a client-supplied `seat` is ignored. `new_round` carries no seat.

## Client → server

### hello (required first message)

```jsonc
{ "type": "hello", "playerId": "<random id from localStorage>" }
```

`playerId` must be a non-empty string of at most 64 characters (the client generates 16). The server assigns a seat (first unknown id → `red`, second → `yellow`, otherwise `spectator`) and replies with `welcome`. Any other message before `hello` — including an invalid `playerId` or an unparseable frame — closes the connection.

### append

```jsonc
{ "type": "append", "index": 12, "event": { "kind": "move", "col": 3 } }
{ "type": "append", "index": 13, "event": { "kind": "new_round" } }
```

`index` must equal the current log length. Structural checks, in order:

1. Sender has a seat (spectators cannot append) → else `rejected: "spectator"`.
2. `index` equals log length → else `rejected: "index_mismatch"`.
3. `event` is well-formed (`move` with integer `col` in 0–6, or `new_round`) → else `rejected: "malformed"`.
4. The log is below its cap (20,000 events — unreachable in legitimate play; it only bounds abuse) → else `rejected: "log_full"`.

On success the server appends, stamps the seat on moves, resets the expiry alarm, and broadcasts `appended` to **all** sockets including the sender. The sender treats its own `appended` broadcast as confirmation; it must not apply the event optimistically before that.

## Server → client

### welcome (reply to hello)

```jsonc
{
  "type": "welcome",
  "seat": "red",                    // "red" | "yellow" | "spectator"
  "log": [ { "kind": "move", "col": 3, "seat": "red" }, ... ],
  "presence": { "red": true, "yellow": false }
}
```

The client replaces any local state for this game by replaying `log`.

### appended (broadcast)

```jsonc
{ "type": "appended", "index": 12, "event": { "kind": "move", "col": 3, "seat": "red" } }
```

If `index` is exactly the client's local log length, append and update. If it is ahead (a gap), the client has missed events: send `resync`. If behind, it is a duplicate: ignore.

### rejected (reply to a failed append)

```jsonc
{ "type": "rejected", "reason": "index_mismatch", "expectedIndex": 14 }
```

`reason` is `"index_mismatch" | "spectator" | "malformed" | "log_full"`. On `index_mismatch` the client resyncs and then re-derives whether its intended action is still legal (usually it isn't — the opponent moved first). The other reasons need no special handling — the client just re-renders.

### presence (broadcast on connect/disconnect)

```jsonc
{ "type": "presence", "red": true, "yellow": false }
```

A seat is `true` while at least one socket holding it is connected. Never stored.

### resync request and reply

```jsonc
// client → server
{ "type": "resync" }
// server → client
{ "type": "log", "log": [ ... ] }
```

Full-log replacement; with logs this small, delta sync isn't worth the code.

## Ordering guarantees

- The log is totally ordered by the Durable Object's single-threaded execution; `index` is authoritative.
- Clients must tolerate duplicate and out-of-date broadcasts (refresh races); the index rules above make handling deterministic.
- An unknown `type` in either direction is ignored, not an error — this is the forward-compatibility rule.
