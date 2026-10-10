import { DurableObject } from "cloudflare:workers";

import { BadgeCache, BADGE_LOOKUP_TTL_MS, badgeFields, isPlayerLinks, type PlayerLinks } from "./badges";
import { allowChat, censorChatText } from "./chat";
import {
  hashesMatch,
  randomPeerId,
  randomToken,
  hashToken,
} from "./crypto";
import { LOBBY_DIRECTORY_NAME, LOBBY_NAMES_LIMIT, type LobbyEntry } from "./lobby";
import { MATCHMAKER_NAME } from "./matchmaker";
import { walletPlayerName } from "./solana";
import type { RoomRoster } from "./stats";
import type { WagerView } from "./wager";

/* when the room's dedicated host last pinged (lobby.ts, DEDICATED_HOST_LEASE_MS) */
const HOST_SEEN_KEY = "hostSeenAt";
/* a dedicated host's match state (lobby, countdown, ingame, postgame) and
   since when, and the data centre it connected through */
const MATCH_STATE_KEY = "matchState";
const MATCH_SINCE_KEY = "matchSince";
const HOST_COLO_KEY = "hostColo";
/* a wagered match's ID: its kills go to that match's wager (src/wager.ts) */
const WAGER_KEY = "wagerMatch";
import {
  MAX_WEBSOCKET_MESSAGE_CHARACTERS,
  IDENTIFIER_PATTERN,
  PEER_ID_PATTERN,
  SIGNALING_PROTOCOL_VERSION,
  TOKEN_PATTERN,
  parseClientMessage,
  parsePlayerProfile,
  type LobbySettings,
  type PeerRole,
  type PlayerProfile,
  type PublicRoomDescriptor,
  type RoomVisibility,
} from "./protocol";

interface RoomRow extends Record<string, SqlStorageValue> {
  build_id: string;
  capacity: number;
  created_at: number;
  dedicated: number;
  expires_at: number;
  guest_ticket_hash: ArrayBuffer;
  host_ticket_hash: ArrayBuffer;
  map_index: number | null;
  mode_index: number | null;
  protocol_version: number;
  room_id: string;
  visibility: string;
}

interface SessionRow extends Record<string, SqlStorageValue> {
  expires_at: number;
  identifier: string;
  peer_id: string;
  role: PeerRole;
  token_hash: ArrayBuffer;
}

interface SocketAttachment {
  departed?: boolean;
  identifier: string;
  joinedAt: number;
  messageCount?: number;
  messageWindowStartedAt?: number;
  peerId: string;
  profile?: PlayerProfile;
  role: PeerRole;
  /* The signed-in wallet this player wagers with, if any. */
  wallet?: string;
  /* matches this player has finished (the matchmaker's count): their rank */
  matches?: number;
  /* watching the game, not in it */
  spectator?: boolean;
  /* the account name behind the wallet (src/profiles.ts), shown with chat
     and the roster when the player has one */
  username?: string;
  /* the links they show (src/badges.ts), and when the room last asked */
  links?: PlayerLinks;
  badgesAt?: number;
  /* text chat: how often this player has spoken lately (src/chat.ts) */
  chatCount?: number;
  chatWindowStartedAt?: number;
}

interface PreparedSession {
  session: MintedSession;
  tokenHash: ArrayBuffer;
}

export interface CreateRoomCommand {
  buildId: string;
  capacity: number;
  dedicated: boolean;
  identifier: string;
  lobby: LobbySettings | null;
  now: number;
  protocolVersion: number;
  roomId: string;
  roomTtlMs: number;
  sessionTtlMs: number;
  visibility: RoomVisibility;
  wallet?: string;
  colo?: string;
}

export type CreateRoomResult =
  | { code: "ROOM_EXISTS"; ok: false }
  | {
      expiresAt: number;
      guestTicket: string;
      hostSession: MintedSession;
      hostTicket: string;
      ok: true;
    };

export interface CreateSessionCommand {
  buildId: string;
  identifier: string;
  now: number;
  protocolVersion: number;
  sessionTtlMs: number;
  /* Absent: a guest of a public room. */
  ticket?: string;
  wallet?: string;
  /* watching, not playing: no player in the game, and not counted against
     the room's player places */
  spectator?: boolean;
}

export type CreateSessionResult =
  | {
      code:
        | "BUILD_MISMATCH"
        | "HOST_ALREADY_CONNECTED"
        | "IDENTIFIER_IN_USE"
        | "INVALID_TICKET"
        | "PROTOCOL_MISMATCH"
        | "ROOM_EXPIRED"
        | "ROOM_FULL"
        | "ROOM_NOT_FOUND";
      ok: false;
    }
  | {
      ok: true;
      room: PublicRoomDescriptor;
      session: MintedSession;
    };

export type CloseRoomResult =
  | { code: "INVALID_TICKET" | "ROOM_NOT_FOUND"; ok: false }
  | { ok: true };

export type RenewRoomResult =
  | { code: "INVALID_TICKET" | "ROOM_NOT_FOUND"; ok: false }
  | { ok: true; room: PublicRoomDescriptor };

export interface MintedSession {
  expiresAt: number;
  identifier: string;
  peerId: string;
  role: PeerRole;
  token: string;
}

function isSocketAttachment(value: unknown): value is SocketAttachment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.profile !== undefined && !parsePlayerProfile(record.profile).ok) {
    return false;
  }
  if (record.username !== undefined && typeof record.username !== "string") {
    return false;
  }
  if (record.links !== undefined && !isPlayerLinks(record.links)) {
    return false;
  }
  return (
    typeof record.joinedAt === "number" &&
    typeof record.identifier === "string" &&
    IDENTIFIER_PATTERN.test(record.identifier) &&
    typeof record.peerId === "string" &&
    PEER_ID_PATTERN.test(record.peerId) &&
    (record.role === "host" || record.role === "guest")
  );
}

function safeAttachment(socket: WebSocket): SocketAttachment | null {
  const attachment: unknown = socket.deserializeAttachment();
  return isSocketAttachment(attachment) ? attachment : null;
}

function jsonMessage(value: unknown): string {
  return JSON.stringify(value);
}

function roomVisibility(value: string): RoomVisibility {
  return value === "public" ? "public" : "private";
}

function roomDescriptor(room: RoomRow): PublicRoomDescriptor {
  if (room.protocol_version !== SIGNALING_PROTOCOL_VERSION) {
    throw new Error("Room row holds an unsupported protocol version.");
  }
  return {
    buildId: room.build_id,
    capacity: room.capacity,
    dedicated: room.dedicated === 1,
    expiresAt: room.expires_at,
    id: room.room_id,
    lobby:
      room.map_index === null || room.mode_index === null
        ? null
        : { mapIndex: room.map_index, modeIndex: room.mode_index },
    protocolVersion: SIGNALING_PROTOCOL_VERSION,
    visibility: roomVisibility(room.visibility),
  };
}

/* Columns added after the first deployment. A room that outlives a deploy
   keeps its table, so they are added to it on first use. */
const ROOM_COLUMN_UPGRADES: ReadonlyArray<readonly [string, string]> = [
  ["visibility", "TEXT NOT NULL DEFAULT 'private'"],
  ["dedicated", "INTEGER NOT NULL DEFAULT 0"],
  ["map_index", "INTEGER"],
  ["mode_index", "INTEGER"],
];

const MAX_GUEST_WEBSOCKET_MESSAGES_PER_MINUTE = 240;
/* watchers a room seats beyond its players */
const MAXIMUM_SPECTATORS = 16;
/* the broadcast (src/broadcast.ts): recorded while a viewer has asked for
   the newest chunk this recently */
const BROADCAST_WATCH_MS = 15_000;
const BROADCAST_LATEST_KEY = "broadcast-latest";
const BROADCAST_WATCHED_KEY = "broadcast-watched-until";
const BROADCAST_ON_KEY = "broadcast-on";
const MAX_HOST_WEBSOCKET_MESSAGES_PER_MINUTE = 16_384;

export class SignalingRoom extends DurableObject<Env> {
  /* the Profiles store's answers, kept a while (src/badges.ts) */
  private readonly badges: BadgeCache;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.badges = new BadgeCache(env);
  }

  private initializeStorage(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS room (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        room_id TEXT NOT NULL,
        build_id TEXT NOT NULL,
        protocol_version INTEGER NOT NULL,
        capacity INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        host_ticket_hash BLOB NOT NULL,
        guest_ticket_hash BLOB NOT NULL,
        visibility TEXT NOT NULL DEFAULT 'private',
        dedicated INTEGER NOT NULL DEFAULT 0,
        map_index INTEGER,
        mode_index INTEGER
      );
      CREATE TABLE IF NOT EXISTS pending_sessions (
        peer_id TEXT PRIMARY KEY,
        role TEXT NOT NULL CHECK (role IN ('host', 'guest')),
        identifier TEXT NOT NULL,
        token_hash BLOB NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pending_sessions_expiry
        ON pending_sessions(expires_at);
    `);
  }

  async createRoom(command: CreateRoomCommand): Promise<CreateRoomResult> {
    const hostTicket = randomToken();
    const guestTicket = randomToken();
    const hostSessionToken = randomToken();
    const [hostTicketHash, guestTicketHash, hostSessionTokenHash] = await Promise.all([
      hashToken(hostTicket),
      hashToken(guestTicket),
      hashToken(hostSessionToken),
    ]);

    // All operations below are synchronous until the reservation is committed,
    // so concurrent create calls cannot both observe an empty room.
    this.initializeStorage();
    if (this.getRoom() !== null) {
      return { code: "ROOM_EXISTS", ok: false };
    }

    const expiresAt = command.now + command.roomTtlMs;
    const hostSession = this.prepareSession(
      "host",
      command.identifier,
      command.now,
      command.sessionTtlMs,
      hostSessionToken,
      hostSessionTokenHash,
    );

    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO room (
          singleton, room_id, build_id, protocol_version, capacity,
          created_at, expires_at, host_ticket_hash, guest_ticket_hash,
          visibility, dedicated, map_index, mode_index
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        command.roomId,
        command.buildId,
        command.protocolVersion,
        command.capacity,
        command.now,
        expiresAt,
        hostTicketHash,
        guestTicketHash,
        command.visibility,
        command.dedicated ? 1 : 0,
        command.lobby === null ? null : command.lobby.mapIndex,
        command.lobby === null ? null : command.lobby.modeIndex,
      );
      this.insertSession(hostSession);
      this.rememberWallet(hostSession.session.peerId, command.wallet);
    });
    if (command.colo !== undefined) this.ctx.storage.kv.put(HOST_COLO_KEY, command.colo);

    await this.ctx.storage.setAlarm(expiresAt);
    await this.publishToDirectory(command.now);

    return {
      expiresAt,
      guestTicket,
      hostSession: hostSession.session,
      hostTicket,
      ok: true,
    };
  }

  async createSession(
    command: CreateSessionCommand,
  ): Promise<CreateSessionResult> {
    const newSessionToken = randomToken();
    const [providedTicketHash, newSessionTokenHash] = await Promise.all([
      command.ticket === undefined ? Promise.resolve(null) : hashToken(command.ticket),
      hashToken(newSessionToken),
    ]);

    // From this point through insertSession(), no operation yields. This makes
    // the capacity check and reservation atomic under a Durable Object's input
    // gate even when many friends click the invite simultaneously.
    const room = this.getRoom();
    if (room === null) {
      await this.expireRoom();
      return { code: "ROOM_NOT_FOUND", ok: false };
    }

    /* A public room seats a ticket-less guest; every other combination must
       present the host or invite capability. */
    const isHost =
      providedTicketHash !== null && hashesMatch(providedTicketHash, room.host_ticket_hash);
    const isGuest =
      providedTicketHash === null
        ? roomVisibility(room.visibility) === "public"
        : hashesMatch(providedTicketHash, room.guest_ticket_hash);
    if (!isHost && !isGuest) {
      return { code: "INVALID_TICKET", ok: false };
    }
    if (command.now >= room.expires_at) {
      await this.expireRoom();
      return { code: "ROOM_EXPIRED", ok: false };
    }
    if (command.protocolVersion !== room.protocol_version) {
      return { code: "PROTOCOL_MISMATCH", ok: false };
    }
    if (command.buildId !== room.build_id) {
      return { code: "BUILD_MISMATCH", ok: false };
    }

    this.removeExpiredSessions(command.now);
    const role: PeerRole = isHost ? "host" : "guest";
    const activeConnections = this.connections();
    const pendingSessions = this.pendingSessionCount(command.now);

    if (
      role === "host" &&
      (activeConnections.some(({ attachment }) => attachment.role === "host") ||
        this.pendingRoleCount("host", command.now) > 0)
    ) {
      return { code: "HOST_ALREADY_CONNECTED", ok: false };
    }
    if (
      activeConnections.some(
        ({ attachment }) => attachment.identifier === command.identifier,
      ) ||
      this.pendingIdentifierCount(command.identifier, command.now) > 0
    ) {
      return { code: "IDENTIFIER_IN_USE", ok: false };
    }
    /* spectators have places of their own */
    const watching = activeConnections.filter(({ attachment }) => attachment.spectator).length;
    if (command.spectator ? watching >= MAXIMUM_SPECTATORS :
        activeConnections.length - watching + pendingSessions >= room.capacity) {
      return { code: "ROOM_FULL", ok: false };
    }

    const session = this.prepareSession(
      role,
      command.identifier,
      command.now,
      command.sessionTtlMs,
      newSessionToken,
      newSessionTokenHash,
    );
    this.insertSession(session);
    if (command.spectator) {
      this.ctx.storage.kv.put(`spectator:${session.session.peerId}`, true);
    } else {
      this.rememberWallet(session.session.peerId, command.wallet);
    }

    return {
      ok: true,
      room: roomDescriptor(room),
      session: session.session,
    };
  }

  /* The host extends the room's life by one TTL from now, and may change the
     lobby settings it advertises (a dedicated host rotating maps). A dedicated
     host renews on a timer so its public lobby never expires while it runs. */
  async renewRoom(
    ticket: string,
    now: number,
    roomTtlMs: number,
    lobby?: LobbySettings,
  ): Promise<RenewRoomResult> {
    const room = this.getRoom();
    if (room === null) {
      await this.expireRoom();
      return { code: "ROOM_NOT_FOUND", ok: false };
    }
    if (!hashesMatch(await hashToken(ticket), room.host_ticket_hash)) {
      return { code: "INVALID_TICKET", ok: false };
    }
    const expiresAt = Math.max(room.expires_at, now + roomTtlMs);
    this.ctx.storage.sql.exec("UPDATE room SET expires_at = ? WHERE singleton = 1", expiresAt);
    if (lobby !== undefined) {
      this.ctx.storage.sql.exec(
        "UPDATE room SET map_index = ?, mode_index = ? WHERE singleton = 1",
        lobby.mapIndex,
        lobby.modeIndex,
      );
    }
    await this.ctx.storage.setAlarm(expiresAt);
    await this.publishToDirectory(now);
    const renewed = this.getRoom();
    if (renewed === null) {
      return { code: "ROOM_NOT_FOUND", ok: false };
    }
    return { ok: true, room: roomDescriptor(renewed) };
  }

  /* The matchmaker's word that this room's match is wagered. */
  async attachWager(matchId: string): Promise<void> {
    this.ctx.storage.kv.put(WAGER_KEY, matchId);
  }

  async closeRoom(ticket: string): Promise<CloseRoomResult> {
    const room = this.getRoom();
    if (room === null) {
      await this.expireRoom();
      return { code: "ROOM_NOT_FOUND", ok: false };
    }
    if (!hashesMatch(await hashToken(ticket), room.host_ticket_hash)) {
      return { code: "INVALID_TICKET", ok: false };
    }
    await this.expireRoom();
    return { ok: true };
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", { status: 426 });
    }

    const room = this.getRoom();
    if (room === null) {
      await this.expireRoom();
      return new Response("Room not found.", { status: 404 });
    }
    const now = Date.now();
    if (now >= room.expires_at) {
      await this.expireRoom();
      return new Response("Room expired.", { status: 410 });
    }

    const url = new URL(request.url);
    const peerId = url.searchParams.get("peer");
    const token = url.searchParams.get("token");
    if (
      peerId === null ||
      !PEER_ID_PATTERN.test(peerId) ||
      token === null ||
      !TOKEN_PATTERN.test(token)
    ) {
      return new Response("Malformed session.", { status: 400 });
    }

    const providedTokenHash = await hashToken(token);

    // Re-read after hashing so two upgrades cannot both consume one session.
    this.removeExpiredSessions(now);
    const session = this.getSession(peerId);
    if (
      session === null ||
      session.expires_at <= now ||
      !hashesMatch(providedTokenHash, session.token_hash)
    ) {
      return new Response("Session is invalid or expired.", { status: 401 });
    }

    const existingConnections = this.connections();
    if (
      existingConnections.some(
        ({ attachment }) => attachment.peerId === session.peer_id,
      )
    ) {
      return new Response("Peer is already connected.", { status: 409 });
    }
    if (
      session.role === "host" &&
      existingConnections.some(({ attachment }) => attachment.role === "host")
    ) {
      return new Response("Host is already connected.", { status: 409 });
    }
    const spectator = this.ctx.storage.kv.get(`spectator:${session.peer_id}`) === true;
    this.ctx.storage.kv.delete(`spectator:${session.peer_id}`);
    const watching = existingConnections.filter(({ attachment }) => attachment.spectator).length;
    if (spectator ? watching >= MAXIMUM_SPECTATORS : existingConnections.length - watching >= room.capacity) {
      return new Response("Room is full.", { status: 409 });
    }

    this.ctx.storage.sql.exec(
      "DELETE FROM pending_sessions WHERE peer_id = ?",
      peerId,
    );

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const wallet = this.takeWallet(session.peer_id);
    const attachment: SocketAttachment = {
      identifier: session.identifier,
      joinedAt: now,
      messageCount: 0,
      messageWindowStartedAt: now,
      peerId: session.peer_id,
      role: session.role,
      ...(wallet === null ? {} : { wallet }),
      ...(spectator ? { spectator: true } : {}),
    };

    this.ctx.acceptWebSocket(server, [
      `peer:${attachment.peerId}`,
      `role:${attachment.role}`,
    ]);
    server.serializeAttachment(attachment);
    server.send(
      jsonMessage({
        peers: existingConnections
          .filter(({ attachment: peer }) => peer.role !== attachment.role)
          .map(({ attachment: peer }) => ({
            identifier: peer.identifier,
            peerId: peer.peerId,
            role: peer.role,
            ...(peer.spectator ? { spectator: true } : {}),
          })),
        room: roomDescriptor(room),
        self: {
          identifier: attachment.identifier,
          peerId: attachment.peerId,
          role: attachment.role,
        },
        type: "welcome",
        v: SIGNALING_PROTOCOL_VERSION,
      }),
    );

    this.broadcastToRole(
      {
        peer: {
          identifier: attachment.identifier,
          peerId: attachment.peerId,
          role: attachment.role,
          ...(attachment.spectator ? { spectator: true } : {}),
        },
        type: "peer-joined",
        v: SIGNALING_PROTOCOL_VERSION,
      },
      attachment.role === "host" ? "guest" : "host",
      server,
    );
    this.broadcastRoster();
    if (attachment.role === "host") {
      this.ctx.storage.kv.put(HOST_SEEN_KEY, now);
      /* a new host records nothing until told (src/broadcast.ts) */
      this.ctx.storage.kv.delete(BROADCAST_ON_KEY);
      this.switchBroadcast(now);
    }
    this.ctx.waitUntil(this.publishToDirectory(now));

    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(
    socket: WebSocket,
    rawMessage: string | ArrayBuffer,
  ): void {
    const sender = safeAttachment(socket);
    if (sender === null || sender.departed === true) {
      socket.close(1008, "Missing connection state.");
      return;
    }

    const now = Date.now();
    if (
      typeof sender.messageWindowStartedAt !== "number" ||
      now - sender.messageWindowStartedAt >= 60_000
    ) {
      sender.messageWindowStartedAt = now;
      sender.messageCount = 0;
    }
    sender.messageCount =
      (typeof sender.messageCount === "number" ? sender.messageCount : 0) + 1;
    try {
      socket.serializeAttachment(sender);
    } catch (error) {
      console.error(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          message: "failed to persist room WebSocket rate state",
          peerId: sender.peerId,
        }),
      );
      this.retireSocket(socket, 1011, "Connection state failed.");
      return;
    }
    const messageLimit =
      sender.role === "host"
        ? MAX_HOST_WEBSOCKET_MESSAGES_PER_MINUTE
        : MAX_GUEST_WEBSOCKET_MESSAGES_PER_MINUTE;
    if (sender.messageCount > messageLimit) {
      this.retireSocket(socket, 1008, "Signaling rate exceeded.");
      return;
    }

    if (
      typeof rawMessage !== "string" ||
      rawMessage.length > MAX_WEBSOCKET_MESSAGE_CHARACTERS
    ) {
      this.retireSocket(socket, 1009, "Signaling message is too large.");
      return;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(rawMessage);
    } catch {
      this.sendError(socket, "INVALID_MESSAGE", "Message must be valid JSON.");
      return;
    }

    const parsed = parseClientMessage(decoded);
    if (!parsed.ok) {
      this.sendError(socket, "INVALID_MESSAGE", parsed.message);
      return;
    }

    const message = parsed.value;
    if (message.type === "ping") {
      /* A dedicated host's ping renews its lease in the directory. */
      const pinger = safeAttachment(socket);
      if (pinger?.role === "host" && this.getRoom()?.dedicated === 1) {
        const now = Date.now();
        this.ctx.storage.kv.put(HOST_SEEN_KEY, now);
        this.ctx.waitUntil(this.publishToDirectory(now));
        /* nobody has watched for a while: the recording stops */
        this.switchBroadcast(now);
      }
      try {
        socket.send(
          jsonMessage({
            ...(message.nonce === undefined
              ? {}
              : { nonce: message.nonce }),
            type: "pong",
            v: SIGNALING_PROTOCOL_VERSION,
          }),
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            message: "failed to send room WebSocket pong",
            peerId: sender.peerId,
          }),
        );
        this.retireSocket(socket, 1011, "Signaling delivery failed.");
      }
      return;
    }

    if (message.type === "waiting") {
      if (sender.role !== "guest") {
        this.sendError(socket, "WAITING_FORBIDDEN", "Only a guest waits to join.");
        return;
      }
      this.broadcastToRole(
        { from: sender.peerId, type: "waiting", v: SIGNALING_PROTOCOL_VERSION },
        "host",
      );
      return;
    }

    if (message.type === "chat") {
      /* Everyone in the room hears a player, under the name they play as
         (and their account name when they have one). A spectator or a
         player who has not said who they are cannot speak; a flood is
         dropped with a note, not a disconnect, so a chatty player keeps
         their game. Nothing is kept. */
      if (sender.spectator === true || sender.profile === undefined) {
        this.sendError(socket, "CHAT_FORBIDDEN", "Only players in the room can chat.");
        return;
      }
      const allowed = allowChat(sender, now);
      try {
        socket.serializeAttachment(sender);
      } catch {
        this.retireSocket(socket, 1011, "Connection state failed.");
        return;
      }
      if (!allowed) {
        this.sendError(socket, "CHAT_RATE_LIMITED", "You're sending messages too quickly.");
        return;
      }
      this.broadcastAll(jsonMessage({
        at: now,
        from: sender.peerId,
        name: sender.profile.name,
        style: sender.profile.style,
        text: censorChatText(message.text),
        type: "chat",
        ...badgeFields(sender),
        v: SIGNALING_PROTOCOL_VERSION,
      }));
      return;
    }

    if (message.type === "match") {
      if (sender.role !== "host") {
        this.sendError(socket, "MATCH_FORBIDDEN", "Only the host reports the match.");
        return;
      }
      this.broadcastToRole(
        {
          ...(message.startsIn === undefined ? {} : { startsIn: message.startsIn }),
          state: message.state,
          type: "match",
          v: SIGNALING_PROTOCOL_VERSION,
          ...(message.vote === undefined ? {} : { vote: message.vote }),
        },
        "guest",
      );
      /* The directory learns the state on a change: quick join skips a
         server mid-match, and the server dashboard shows it. */
      if (this.ctx.storage.kv.get(MATCH_STATE_KEY) !== message.state) {
        this.ctx.storage.kv.put(MATCH_STATE_KEY, message.state);
        this.ctx.storage.kv.put(MATCH_SINCE_KEY, now);
        this.ctx.waitUntil(this.publishToDirectory(now));
      }
      return;
    }

    if (message.type === "vote") {
      /* the post-match vote: a guest's pick, to the host that tallies it */
      if (sender.role !== "guest") {
        this.sendError(socket, "VOTE_FORBIDDEN", "Only a guest votes.");
        return;
      }
      this.broadcastToRole(
        { from: sender.peerId, mapIndex: message.mapIndex, modeIndex: message.modeIndex, type: "vote", v: SIGNALING_PROTOCOL_VERSION },
        "host",
      );
      return;
    }

    if (message.type === "pings") {
      if (sender.role !== "host") {
        this.sendError(socket, "PINGS_FORBIDDEN", "Only the host measures pings.");
        return;
      }
      /* by the name each plays under (the scoreboard's) */
      const byName: Record<string, number> = {};
      for (const { attachment } of this.connections("guest")) {
        if (attachment.spectator) continue;
        const ping = message.pings[attachment.peerId];
        if (ping !== undefined && attachment.profile?.name) byName[attachment.profile.name] = ping;
      }
      this.broadcastToRole({ pings: byName, type: "pings", v: SIGNALING_PROTOCOL_VERSION }, "guest");
      return;
    }

    if (message.type === "kill") {
      this.ctx.waitUntil(this.settleKill(socket, sender, message.killer, message.victim));
      return;
    }

    if (message.type === "profile") {
      /* A wagering player plays under their wallet's name, so a kill report
         can never be pinned on someone else. */
      sender.profile = sender.wallet === undefined ? message.profile :
        { ...message.profile, name: walletPlayerName(sender.wallet) };
      if (sender.role === "guest" && !sender.spectator) {
        this.rememberSeat(sender.identifier, sender.profile.name, sender.wallet ?? null);
      }
      if (sender.matches === undefined && sender.role === "guest") {
        this.ctx.waitUntil(this.lookUpRank(sender.peerId, sender.identifier));
      }
      if (sender.wallet !== undefined && (sender.badgesAt === undefined || now - sender.badgesAt >= BADGE_LOOKUP_TTL_MS)) {
        sender.badgesAt = now;
        this.ctx.waitUntil(this.lookUpBadges(sender.peerId, sender.wallet, now));
      }
      try {
        socket.serializeAttachment(sender);
      } catch (error) {
        console.error(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            message: "failed to persist player profile",
            peerId: sender.peerId,
          }),
        );
        this.retireSocket(socket, 1011, "Connection state failed.");
        return;
      }
      this.broadcastRoster();
      this.ctx.waitUntil(this.publishToDirectory(now));
      return;
    }

    const target = this.connectionForPeer(message.to);
    if (target === undefined) {
      this.sendError(socket, "PEER_NOT_FOUND", "Target peer is not connected.");
      return;
    }
    if (
      sender.role === target.attachment.role ||
      (sender.role === "guest" && target.attachment.role !== "host")
    ) {
      this.sendError(
        socket,
        "SIGNAL_ROUTE_FORBIDDEN",
        "Signals must travel between the host and a guest.",
      );
      return;
    }
    if (
      "description" in message.signal &&
      ((sender.role === "host" && message.signal.description.type !== "offer") ||
        (sender.role === "guest" && message.signal.description.type !== "answer"))
    ) {
      this.sendError(
        socket,
        "SIGNAL_DIRECTION_INVALID",
        "The session description direction is invalid for this peer.",
      );
      return;
    }

    try {
      target.socket.send(
        jsonMessage({
          from: sender.peerId,
          signal: message.signal,
          type: "signal",
          v: SIGNALING_PROTOCOL_VERSION,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          message: "failed to relay room WebSocket message",
          peerId: target.attachment.peerId,
        }),
      );
      this.retireSocket(target.socket, 1011, "Signaling delivery failed.");
      this.sendError(socket, "PEER_NOT_FOUND", "Target peer is not connected.");
    }
  }

  override webSocketClose(socket: WebSocket): void {
    this.announceDeparture(socket);
  }

  override webSocketError(socket: WebSocket, error: unknown): void {
    const attachment = safeAttachment(socket);
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        message: "room WebSocket error",
        peerId: attachment?.peerId ?? "unknown",
      }),
    );
    this.retireSocket(socket, 1011, "WebSocket error.");
  }

  override async alarm(): Promise<void> {
    await this.expireRoom();
  }

  private announceDeparture(socket: WebSocket): void {
    const attachment = safeAttachment(socket);
    if (attachment === null || attachment.departed === true) {
      return;
    }
    attachment.departed = true;
    try {
      socket.serializeAttachment(attachment);
    } catch {
      // The socket may already be fully closed; readyState filtering still
      // prevents it from participating in room membership.
    }
    this.broadcastToRole(
      {
        identifier: attachment.identifier,
        peerId: attachment.peerId,
        reason: attachment.role === "host" ? "host-disconnected" : "disconnected",
        type: "peer-left",
        v: SIGNALING_PROTOCOL_VERSION,
      },
      attachment.role === "host" ? "guest" : "host",
      socket,
    );
    this.broadcastRoster();
    this.ctx.waitUntil(this.publishToDirectory(Date.now()));
  }

  /* A public room's entry in the lobby directory. Failures are logged, never
     raised: the directory is a convenience for quick join, not a record. */
  private async publishToDirectory(now: number): Promise<void> {
    let room: RoomRow | null;
    try {
      room = this.getRoom();
    } catch {
      return;
    }
    if (room === null || roomVisibility(room.visibility) !== "public") {
      return;
    }
    /* the players: spectators watch, they do not fill places */
    const connections = this.connections().filter(({ attachment }) => !attachment.spectator);
    const hostConnected = connections.some(({ attachment }) => attachment.role === "host");
    const guests = connections.length - (hostConnected ? 1 : 0);
    const entry: LobbyEntry = {
      buildId: room.build_id,
      capacity: room.capacity,
      createdAt: room.created_at,
      dedicated: room.dedicated === 1,
      expiresAt: room.expires_at,
      hostConnected,
      hostSeenAt: room.dedicated === 1 ? Number(this.ctx.storage.kv.get(HOST_SEEN_KEY) ?? 0) : 0,
      matchState: String(this.ctx.storage.kv.get(MATCH_STATE_KEY) ?? ""),
      matchSince: Number(this.ctx.storage.kv.get(MATCH_SINCE_KEY) ?? 0),
      colo: String(this.ctx.storage.kv.get(HOST_COLO_KEY) ?? ""),
      mapIndex: room.map_index,
      modeIndex: room.mode_index,
      names: connections
        .filter(({ attachment }) => attachment.profile !== undefined)
        .slice(0, LOBBY_NAMES_LIMIT)
        .map(({ attachment }) => ({
          host: attachment.role === "host",
          name: attachment.profile?.name ?? "",
          style: attachment.profile?.style ?? "sage",
        })),
      /* A dedicated host is not a player; a browser host is. */
      players: guests + (hostConnected && room.dedicated !== 1 ? 1 : 0),
      protocolVersion: room.protocol_version,
      roomId: room.room_id,
    };
    try {
      await this.env.LOBBY_DIRECTORY.getByName(LOBBY_DIRECTORY_NAME).upsert(entry, now);
    } catch (error) {
      console.error(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          message: "failed to publish room to the lobby directory",
        }),
      );
    }
  }

  private async withdrawFromDirectory(): Promise<void> {
    let room: RoomRow | null;
    try {
      room = this.getRoom();
    } catch {
      return;
    }
    if (room === null || roomVisibility(room.visibility) !== "public") {
      return;
    }
    try {
      await this.env.LOBBY_DIRECTORY.getByName(LOBBY_DIRECTORY_NAME).remove(room.room_id);
    } catch (error) {
      console.error(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          message: "failed to withdraw room from the lobby directory",
        }),
      );
    }
  }

  /* A player's rank comes from the matchmaker's count of their finished
     matches, never from the player. */
  private async lookUpRank(peerId: string, identifier: string): Promise<void> {
    let matches: number | null = null;
    try {
      matches = await this.env.MATCHMAKER.getByName(MATCHMAKER_NAME).matchesFor(identifier);
    } catch {
      return;
    }
    const connection = this.connectionForPeer(peerId);
    if (!connection || matches === null) return;
    connection.attachment.matches = matches;
    try {
      connection.socket.serializeAttachment(connection.attachment);
    } catch {
      /* the socket is closing */
    }
    this.broadcastRoster();
  }

  /* A wallet's account name and shown links (src/badges.ts): the roster
     and chat show them beside the in-game name once they are known. The
     room asks the Profiles store again only after BADGE_LOOKUP_TTL_MS. */
  private async lookUpBadges(peerId: string, wallet: string, now: number): Promise<void> {
    const badges = (await this.badges.lookUp([wallet], now)).get(wallet);
    const connection = this.connectionForPeer(peerId);
    if (!connection || connection.attachment.wallet !== wallet) return;
    if (badges === undefined) {
      /* the store didn't answer: ask again with the next profile */
      delete connection.attachment.badgesAt;
      this.persistAttachment(connection);
      return;
    }
    const before = JSON.stringify(badgeFields(connection.attachment));
    if (badges.username === undefined) delete connection.attachment.username;
    else connection.attachment.username = badges.username;
    if (badges.links === undefined) delete connection.attachment.links;
    else connection.attachment.links = badges.links;
    this.persistAttachment(connection);
    if (JSON.stringify(badgeFields(connection.attachment)) !== before) this.broadcastRoster();
  }

  private persistAttachment(connection: { socket: WebSocket; attachment: SocketAttachment }): void {
    try {
      connection.socket.serializeAttachment(connection.attachment);
    } catch {
      /* the socket is closing */
    }
  }

  private broadcastRoster(): void {
    const connections = this.connections();
    const encoded = jsonMessage({
      players: connections.map(({ attachment }) => ({
        peerId: attachment.peerId,
        profile: attachment.profile ?? null,
        role: attachment.role,
        matches: attachment.matches ?? null,
        ...(attachment.spectator ? { spectator: true } : {}),
        ...badgeFields(attachment),
      })),
      type: "roster",
      v: SIGNALING_PROTOCOL_VERSION,
    });
    for (const { socket } of connections) {
      try {
        socket.send(encoded);
      } catch (error) {
        console.error(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            message: "failed to send room roster",
          }),
        );
        this.retireSocket(socket, 1011, "Signaling delivery failed.");
      }
    }
  }

  private broadcastToRole(
    message: unknown,
    role: PeerRole,
    excluded?: WebSocket,
  ): void {
    const encoded = jsonMessage(message);
    for (const { socket } of this.connections(role)) {
      if (socket === excluded) {
        continue;
      }
      try {
        socket.send(encoded);
      } catch (error) {
        console.error(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            message: "failed to send room WebSocket message",
          }),
        );
        this.retireSocket(socket, 1011, "Signaling delivery failed.");
      }
    }
  }

  private retireSocket(socket: WebSocket, code: number, reason: string): void {
    this.announceDeparture(socket);
    try {
      socket.close(code, reason);
    } catch {
      // An errored socket can already be closed by the runtime.
    }
  }

  private connections(): Array<{
    attachment: SocketAttachment;
    socket: WebSocket;
  }>;
  private connections(role: PeerRole): Array<{
    attachment: SocketAttachment;
    socket: WebSocket;
  }>;
  private connections(role?: PeerRole): Array<{
    attachment: SocketAttachment;
    socket: WebSocket;
  }> {
    const result: Array<{
      attachment: SocketAttachment;
      socket: WebSocket;
    }> = [];
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) {
        continue;
      }
      const attachment = safeAttachment(socket);
      if (
        attachment !== null &&
        attachment.departed !== true &&
        (role === undefined || attachment.role === role)
      ) {
        result.push({ attachment, socket });
      }
    }
    return result;
  }

  private connectionForPeer(peerId: string):
    | { attachment: SocketAttachment; socket: WebSocket }
    | undefined {
    for (const socket of this.ctx.getWebSockets(`peer:${peerId}`)) {
      if (socket.readyState !== WebSocket.OPEN) {
        continue;
      }
      const attachment = safeAttachment(socket);
      if (
        attachment !== null &&
        attachment.departed !== true &&
        attachment.peerId === peerId
      ) {
        return { attachment, socket };
      }
    }
    return undefined;
  }

  private async expireRoom(): Promise<void> {
    await this.withdrawFromDirectory();
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.close(4001, "Room expired.");
      } catch {
        // The socket may already have closed between enumeration and close().
      }
    }
    await this.ctx.storage.deleteAll();
  }

  private getRoom(): RoomRow | null {
    try {
      return this.selectRoom();
    } catch (error) {
      if (error instanceof Error && error.message.includes("no such table")) {
        return null;
      }
      if (error instanceof Error && error.message.includes("no such column")) {
        this.upgradeRoomColumns();
        return this.selectRoom();
      }
      throw error;
    }
  }

  private selectRoom(): RoomRow | null {
    return (
      this.ctx.storage.sql
        .exec<RoomRow>(
          `SELECT room_id, build_id, protocol_version, capacity, created_at,
                  expires_at, host_ticket_hash, guest_ticket_hash,
                  visibility, dedicated, map_index, mode_index
             FROM room WHERE singleton = 1`,
        )
        .toArray()[0] ?? null
    );
  }

  private upgradeRoomColumns(): void {
    const existing = new Set(
      this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(room)")
        .toArray()
        .map(({ name }) => name),
    );
    for (const [column, definition] of ROOM_COLUMN_UPGRADES) {
      if (!existing.has(column)) {
        this.ctx.storage.sql.exec(`ALTER TABLE room ADD COLUMN ${column} ${definition}`);
      }
    }
  }

  /* ---------- who played, for the match's stats (src/stats.ts) */

  /* The room keeps each player's seat (their machine, the name they play
     under, their wallet) and the kills the dedicated host reported, so a
     finished match's result, which names players, can be put to the
     players' lasting records after they have gone. */
  private seatTables(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS match_seats (identifier TEXT PRIMARY KEY, name TEXT NOT NULL, wallet TEXT);
      CREATE TABLE IF NOT EXISTS match_kills (
        name TEXT PRIMARY KEY, kills INTEGER NOT NULL DEFAULT 0, deaths INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  private rememberSeat(identifier: string, name: string, wallet: string | null): void {
    this.seatTables();
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO match_seats (identifier, name, wallet) VALUES (?, ?, ?)", identifier, name, wallet,
    );
  }

  /* an enemy kill, as the server reports them: a kill for one, a death
     for the other */
  private countKill(killerName: string, victimName: string): void {
    this.seatTables();
    if (killerName !== victimName) {
      this.ctx.storage.sql.exec(
        `INSERT INTO match_kills (name, kills) VALUES (?, 1)
         ON CONFLICT(name) DO UPDATE SET kills = kills + 1`, killerName,
      );
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO match_kills (name, deaths) VALUES (?, 1)
       ON CONFLICT(name) DO UPDATE SET deaths = deaths + 1`, victimName,
    );
  }

  /* Every seat the room has had, and every name's kills and deaths. */
  async matchRoster(): Promise<RoomRoster> {
    this.seatTables();
    return {
      seats: this.ctx.storage.sql.exec<{ identifier: string; name: string; wallet: string | null }>(
        "SELECT identifier, name, wallet FROM match_seats ORDER BY identifier",
      ).toArray(),
      kills: this.ctx.storage.sql.exec<{ name: string; kills: number; deaths: number }>(
        "SELECT name, kills, deaths FROM match_kills ORDER BY name",
      ).toArray(),
    };
  }

  /* A pending session's wallet, until its socket opens. */
  private walletTable(): void {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS session_wallets (peer_id TEXT PRIMARY KEY, wallet TEXT NOT NULL)",
    );
  }

  private rememberWallet(peerId: string, wallet: string | undefined): void {
    if (wallet === undefined) return;
    this.walletTable();
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO session_wallets (peer_id, wallet) VALUES (?, ?)",
      peerId,
      wallet,
    );
  }

  private takeWallet(peerId: string): string | null {
    this.walletTable();
    const wallet = this.ctx.storage.sql
      .exec<{ wallet: string }>("SELECT wallet FROM session_wallets WHERE peer_id = ?", peerId)
      .toArray()[0]?.wallet ?? null;
    this.ctx.storage.sql.exec("DELETE FROM session_wallets WHERE peer_id = ?", peerId);
    return wallet;
  }

  /* A dedicated host reports a kill by names. In a wagered match the bounty
     moves between the two players' match balances (src/wager.ts), and
     everyone in the room hears the new balances. */
  private async settleKill(
    socket: WebSocket,
    sender: SocketAttachment,
    killerName: string,
    victimName: string,
  ): Promise<void> {
    const room = this.getRoom();
    if (room === null || room.dedicated !== 1 || sender.role !== "host") {
      this.sendError(socket, "KILL_FORBIDDEN", "Only a dedicated host reports kills.");
      return;
    }
    this.countKill(killerName, victimName);
    const wagerMatch = this.ctx.storage.kv.get(WAGER_KEY) as string | undefined;
    if (wagerMatch !== undefined) {
      const result = await this.env.WAGERS.getByName(wagerMatch).kill(killerName, victimName);
      if (result === null) return;
      this.broadcastAll(jsonMessage({
        killer: killerName,
        lamports: result.moved,
        type: "wager",
        v: SIGNALING_PROTOCOL_VERSION,
        victim: victimName,
        wager: result.view,
      }));
      this.outOfSol(socket, result.moved, victimName, result.view);
      return;
    }
    /* a free match's kills move nothing */
  }

  /* ---------- the broadcast (src/broadcast.ts) */

  /* The newest chunk the room's server has put up. */
  async noteBroadcastChunk(sequence: number, now: number): Promise<void> {
    this.ctx.storage.kv.put(BROADCAST_LATEST_KEY, { sequence, at: now });
  }

  /* A viewer asks for the newest chunk: the recording goes on (or starts)
     for a while yet. */
  async watchBroadcast(now: number): Promise<{ sequence: number; at: number } | null> {
    this.ctx.storage.kv.put(BROADCAST_WATCHED_KEY, now + BROADCAST_WATCH_MS);
    this.switchBroadcast(now);
    return (this.ctx.storage.kv.get(BROADCAST_LATEST_KEY) as { sequence: number; at: number } | undefined) ?? null;
  }

  /* Tells the server to record or stop, when that changes. */
  private switchBroadcast(now: number): void {
    const watched = Number(this.ctx.storage.kv.get(BROADCAST_WATCHED_KEY) ?? 0) > now;
    const on = this.ctx.storage.kv.get(BROADCAST_ON_KEY) === true;
    if (watched === on) return;
    let told = false;
    for (const { socket } of this.connections("host")) {
      try {
        socket.send(jsonMessage({ on: watched, type: "broadcast", v: SIGNALING_PROTOCOL_VERSION }));
        told = true;
      } catch {
        /* closing: the next host hears it when it connects */
      }
    }
    if (told) this.ctx.storage.kv.put(BROADCAST_ON_KEY, watched);
  }

  /* A bounty match: a player whose stake is spent is out. Once only one
     player has SOL left the match ends there (a duel at its first such
     kill), and pays out as any finished match; otherwise the broke player
     leaves and the others play on. Max kills and the time limit still end
     it as usual. */
  private outOfSol(host: WebSocket, moved: number, victimName: string, view: WagerView): void {
    if (moved <= 0 || view.mode === "team") return;
    const victim = view.players.find((player) => player.name === victimName);
    if (!victim || victim.balance > 0) return;
    const funded = view.players.filter((player) => player.balance > 0).length;
    const end = funded <= 1;
    const out = end ? [] : this.connections("guest")
      .filter(({ attachment }) => !attachment.spectator && attachment.profile?.name === victimName)
      .map(({ attachment }) => attachment.peerId);
    for (const peerId of out) {
      for (const target of this.ctx.getWebSockets(`peer:${peerId}`)) {
        try {
          target.send(jsonMessage({ type: "out_of_sol", v: SIGNALING_PROTOCOL_VERSION }));
        } catch {
          /* closing anyway */
        }
      }
    }
    try {
      host.send(jsonMessage({ end, out, type: "wager_out", v: SIGNALING_PROTOCOL_VERSION }));
    } catch {
      /* the host is gone; the match ends without it */
    }
  }

  private broadcastAll(encoded: string): void {
    for (const { socket: target } of this.connections()) {
      try {
        target.send(encoded);
      } catch {
        /* A closing socket misses one notice. */
      }
    }
  }

  private getSession(peerId: string): SessionRow | null {
    return (
      this.ctx.storage.sql
        .exec<SessionRow>(
          `SELECT peer_id, role, identifier, token_hash, expires_at
             FROM pending_sessions WHERE peer_id = ?`,
          peerId,
        )
        .toArray()[0] ?? null
    );
  }

  private insertSession(prepared: PreparedSession): void {
    const { session, tokenHash } = prepared;
    this.ctx.storage.sql.exec(
      `INSERT INTO pending_sessions
         (peer_id, role, identifier, token_hash, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      session.peerId,
      session.role,
      session.identifier,
      tokenHash,
      session.expiresAt,
    );
  }

  private prepareSession(
    role: PeerRole,
    identifier: string,
    now: number,
    ttlMs: number,
    token: string,
    tokenHash: ArrayBuffer,
  ): PreparedSession {
    return {
      session: {
        expiresAt: now + ttlMs,
        identifier,
        peerId: randomPeerId(role),
        role,
        token,
      },
      tokenHash,
    };
  }

  private pendingRoleCount(role: PeerRole, now: number): number {
    return this.ctx.storage.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM pending_sessions
          WHERE role = ? AND expires_at > ?`,
        role,
        now,
      )
      .one().count;
  }

  private pendingIdentifierCount(identifier: string, now: number): number {
    return this.ctx.storage.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM pending_sessions
          WHERE identifier = ? AND expires_at > ?`,
        identifier,
        now,
      )
      .one().count;
  }

  private pendingSessionCount(now: number): number {
    return this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM pending_sessions WHERE expires_at > ?",
        now,
      )
      .one().count;
  }

  private removeExpiredSessions(now: number): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM pending_sessions WHERE expires_at <= ?",
      now,
    );
  }

  private sendError(socket: WebSocket, code: string, message: string): void {
    try {
      socket.send(
        jsonMessage({
          code,
          message,
          type: "error",
          v: SIGNALING_PROTOCOL_VERSION,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          message: "failed to send room WebSocket error",
        }),
      );
      this.retireSocket(socket, 1011, "Signaling delivery failed.");
    }
  }
}
