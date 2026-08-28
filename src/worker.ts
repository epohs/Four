/**
 * Four — Cloudflare Worker entry point.
 *
 * The Worker routes WebSocket upgrades on /g/<code>/ws to the Durable
 * Object for that game code; every other request falls through to the
 * static assets (with SPA fallback configured in wrangler.jsonc).
 *
 * GameDO is the per-game Durable Object: append-only event log, seat
 * map, presence, expiry alarm. Protocol contract: docs/protocol.md.
 * The server validates structure only — it knows nothing of the rules
 * of 4-in-a-row.
 */

interface Env {
  GAME: DurableObjectNamespace;
  ASSETS: Fetcher;
}

const WS_PATH = /^\/g\/([A-Za-z0-9_-]+)\/ws$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(WS_PATH);

    if (match) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      const code = match[1]!;
      const stub = env.GAME.get(env.GAME.idFromName(code));
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

type Seat = "red" | "yellow" | "spectator";

type GameEvent =
  | { kind: "move"; col: number; seat?: Seat }
  | { kind: "new_round" };

/** Per-socket state, kept in the hibernation-safe attachment. */
interface Attachment {
  playerId: string;
  seat: Seat;
}

const EXPIRY_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

// Longest playerId accepted in hello; the client generates 16 chars.
// Bounds the seat map and keeps the socket attachment under its 2KB limit.
const MAX_PLAYER_ID = 64;

// Log cap: a legitimate game never approaches this (~475 full rounds),
// but it keeps a hostile client from growing the stored log until the
// storage write fails. Past it, appends are rejected with "log_full".
const MAX_LOG = 20000;

export class GameDO implements DurableObject {
  constructor(private state: DurableObjectState) {}

  async fetch(_request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Hibernation API: the runtime holds the socket and wakes us per
    // message, so idle games cost nothing. No attachment until hello.
    this.state.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment | null;

    let msg: any = null;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      // fall through with msg = null
    }
    if (typeof msg !== "object" || msg === null) {
      // Post-hello, tolerate junk frames; pre-hello, anything that isn't
      // a valid hello closes the connection (protocol.md).
      if (!attachment) ws.close(1008, "hello required");
      return;
    }

    // hello is the required first message; anything else first closes.
    if (!attachment) {
      if (
        msg.type === "hello" &&
        typeof msg.playerId === "string" &&
        msg.playerId !== "" &&
        msg.playerId.length <= MAX_PLAYER_ID
      ) {
        await this.handleHello(ws, msg.playerId);
      } else {
        ws.close(1008, "hello required");
      }
      return;
    }

    switch (msg.type) {
      case "append":
        await this.handleAppend(ws, attachment, msg);
        break;
      case "resync":
        send(ws, { type: "log", log: await this.getLog() });
        break;
      default:
        break; // unknown types are ignored — forward-compatibility rule
    }
  }

  // The closing socket can still appear in getWebSockets() while these
  // handlers run, so it is excluded from the presence computation.
  async webSocketClose(ws: WebSocket): Promise<void> {
    this.broadcastPresence(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.broadcastPresence(ws);
  }

  /** Expiry: fire means 90 days of silence — delete the game. */
  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }

  private async handleHello(ws: WebSocket, playerId: string): Promise<void> {
    const seats = (await this.state.storage.get<Record<string, Seat>>("seats")) ?? {};

    let seat = seats[playerId];
    if (!seat) {
      const taken = new Set(Object.values(seats));
      seat = !taken.has("red") ? "red" : !taken.has("yellow") ? "yellow" : "spectator";
      if (seat !== "spectator") {
        seats[playerId] = seat;
        await this.state.storage.put("seats", seats);
      }
    }

    ws.serializeAttachment({ playerId, seat } satisfies Attachment);
    await this.resetExpiry();

    send(ws, {
      type: "welcome",
      seat,
      log: await this.getLog(),
      presence: this.presence(),
    });
    this.broadcastPresence();
  }

  private async handleAppend(ws: WebSocket, attachment: Attachment, msg: any): Promise<void> {
    // Structural checks, in protocol order: spectator, index, shape.
    if (attachment.seat === "spectator") {
      send(ws, { type: "rejected", reason: "spectator" });
      return;
    }

    const log = await this.getLog();
    if (msg.index !== log.length) {
      send(ws, { type: "rejected", reason: "index_mismatch", expectedIndex: log.length });
      return;
    }

    const event = wellFormed(msg.event);
    if (!event) {
      send(ws, { type: "rejected", reason: "malformed" });
      return;
    }

    if (log.length >= MAX_LOG) {
      send(ws, { type: "rejected", reason: "log_full" });
      return;
    }

    // The server stamps the seat; whatever the client sent is ignored.
    if (event.kind === "move") event.seat = attachment.seat;

    log.push(event);
    await this.state.storage.put("log", log);
    await this.resetExpiry();

    this.broadcast({ type: "appended", index: log.length - 1, event });
  }

  private async getLog(): Promise<GameEvent[]> {
    return (await this.state.storage.get<GameEvent[]>("log")) ?? [];
  }

  private async resetExpiry(): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + EXPIRY_MS);
  }

  /** A seat is present while at least one socket holding it is connected. */
  private presence(except?: WebSocket): { red: boolean; yellow: boolean } {
    const present = { red: false, yellow: false };
    for (const socket of this.state.getWebSockets()) {
      if (socket === except) continue;
      const a = socket.deserializeAttachment() as Attachment | null;
      if (a && (a.seat === "red" || a.seat === "yellow")) present[a.seat] = true;
    }
    return present;
  }

  private broadcastPresence(except?: WebSocket): void {
    this.broadcast({ type: "presence", ...this.presence(except) });
  }

  private broadcast(msg: unknown): void {
    const frame = JSON.stringify(msg);
    for (const socket of this.state.getWebSockets()) {
      try {
        socket.send(frame);
      } catch {
        // a socket mid-close is not our problem; close events handle presence
      }
    }
  }
}

/** Returns a fresh copy of the event if structurally valid, else null. */
function wellFormed(event: any): GameEvent | null {
  if (typeof event !== "object" || event === null) return null;
  if (event.kind === "new_round") return { kind: "new_round" };
  if (
    event.kind === "move" &&
    Number.isInteger(event.col) &&
    event.col >= 0 &&
    event.col <= 6
  ) {
    return { kind: "move", col: event.col };
  }
  return null;
}

function send(ws: WebSocket, msg: unknown): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // socket already closed; nothing to do
  }
}
