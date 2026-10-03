export const SIGNALING_PROTOCOL_VERSION = 1 as const;
export const MAX_HTTP_BODY_BYTES = 4_096;
export const MAX_WEBSOCKET_MESSAGE_CHARACTERS = 65_536;

export const ROOM_ID_PATTERN =
  /^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){3}_[A-Za-z0-9_-]{43}$/u;
export const PEER_ID_PATTERN = /^[hg]_[A-Za-z0-9_-]{16}$/u;
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,64}$/u;
export const IDENTIFIER_PATTERN = /^[0-9a-f]{12}$/u;
const BUILD_ID_PATTERN = /^[A-Za-z0-9._:+-]{1,96}$/u;
/* The 13 stock multiplayer maps and 6 game modes the browser lobby offers, in
   the order of port/web/src/web_online_ui.h. */
export const LOBBY_MAP_COUNT = 13;
export const LOBBY_MODE_COUNT = 8;

export const PLAYER_STYLES = [
  "white",
  "black",
  "red",
  "blue",
  "sage",
  "yellow",
  "lime",
  "pink",
  "purple",
  "cyan",
  "cornflower",
  "orange",
  "teal",
  "forest",
  "brown",
  "tan",
  "maroon",
  "rose",
] as const;

export type PlayerStyle = (typeof PLAYER_STYLES)[number];

/* Halo 3's emblem symbols the lobby offers (emblem_foregrounds_ui.png) */
export const EMBLEM_COUNT = 70;
export const PLAYER_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u;

export interface PlayerProfile {
  name: string;
  style: PlayerStyle;
  emblem?: number;
}

export type PeerRole = "host" | "guest";

export const MATCH_STATES = ["lobby", "countdown", "ingame", "postgame"] as const;
export type MatchState = (typeof MATCH_STATES)[number];

/* A private room is reachable only through its invite capability. A public
   room is additionally listed in the lobby directory, and anyone on the same
   build may join it through quick join or a ticket-less session request. */
export type RoomVisibility = "private" | "public";

export interface LobbySettings {
  mapIndex: number;
  modeIndex: number;
}

export interface CreateRoomInput {
  buildId: string;
  capacity?: number;
  /* Only a host presenting the dedicated-host service credential may set
     this. It lengthens the room TTL and ranks the room first in quick join. */
  dedicated?: boolean;
  identifier: string;
  lobby?: LobbySettings;
  protocolVersion: typeof SIGNALING_PROTOCOL_VERSION;
  turnstileToken?: string;
  visibility?: RoomVisibility;
  /* A wallet sign-in session (POST /v1/auth/verify): the player wagers. */
  walletToken?: string;
}

export interface CreateSessionInput {
  buildId: string;
  identifier: string;
  protocolVersion: typeof SIGNALING_PROTOCOL_VERSION;
  /* Absent for a guest of a public room. */
  ticket?: string;
  turnstileToken?: string;
  walletToken?: string;
}

export interface QuickJoinInput {
  buildId: string;
  identifier: string;
  protocolVersion: typeof SIGNALING_PROTOCOL_VERSION;
  turnstileToken?: string;
  walletToken?: string;
  /* click to play: a dedicated server's game only, never hosting one */
  serversOnly?: boolean;
  /* ... playing one of these game types (LOBBY_MODE_COUNT) */
  modes?: number[];
  /* to watch, not play */
  spectator?: boolean;
}

export interface SessionDescriptor {
  identifier: string;
  peerId: string;
  role: PeerRole;
  token: string;
  websocketUrl: string;
}

export interface IceServerDescriptor {
  credential?: string;
  credentialType?: "password";
  urls: string[];
  username?: string;
}

export interface PublicRoomDescriptor {
  buildId: string;
  capacity: number;
  dedicated: boolean;
  expiresAt: number;
  id: string;
  lobby: LobbySettings | null;
  protocolVersion: typeof SIGNALING_PROTOCOL_VERSION;
  visibility: RoomVisibility;
}

export interface CreateRoomResponse {
  host: {
    session: SessionDescriptor;
    ticket: string;
  };
  invite: {
    code: string;
    url: string;
  };
  iceServers: IceServerDescriptor[];
  iceServersExpiresAt: number | null;
  room: PublicRoomDescriptor;
  v: typeof SIGNALING_PROTOCOL_VERSION;
}

export interface CreateSessionResponse {
  iceServers: IceServerDescriptor[];
  iceServersExpiresAt: number | null;
  room: PublicRoomDescriptor;
  session: SessionDescriptor;
  v: typeof SIGNALING_PROTOCOL_VERSION;
}

/* Quick join either seats the caller in an open public room or, when there is
   none, makes the caller the host of a new public room. */
export type QuickJoinResponse =
  | (CreateSessionResponse & { role: "guest" })
  | (CreateRoomResponse & { role: "host" });

export interface RenewRoomResponse {
  room: PublicRoomDescriptor;
  v: typeof SIGNALING_PROTOCOL_VERSION;
}

export type SessionDescriptionSignal = {
  description: {
    sdp: string;
    type: "answer" | "offer";
  };
  kind: "description";
};

export type IceCandidateSignal = {
  candidate:
    | {
        candidate: string;
        sdpMid: string | null;
        sdpMLineIndex: number | null;
        usernameFragment?: string | null;
      }
    | null;
  kind: "candidate";
};

export type WebRtcSignal = IceCandidateSignal | SessionDescriptionSignal;

export type ClientMessage =
  | {
      nonce?: string;
      type: "ping";
      v: typeof SIGNALING_PROTOCOL_VERSION;
    }
  | {
      profile: PlayerProfile;
      type: "profile";
      v: typeof SIGNALING_PROTOCOL_VERSION;
    }
  | {
      /* A dedicated host's report of a kill, by the players' names; the room
         moves the wager between their wallets. */
      killer: string;
      type: "kill";
      v: typeof SIGNALING_PROTOCOL_VERSION;
      victim: string;
    }
  | {
      /* A dedicated host's measure of each player's ping (milliseconds, by
         peer ID); the room passes it on to everyone by name. */
      pings: Record<string, number>;
      type: "pings";
      v: typeof SIGNALING_PROTOCOL_VERSION;
    }
  | {
      /* A guest trying to join a running match, relayed to the host, which
         wraps the match up so the next one includes them. */
      type: "waiting";
      v: typeof SIGNALING_PROTOCOL_VERSION;
    }
  | {
      /* The host's match status, relayed to its guests (the lobby's
         countdown). startsIn is set while counting down. */
      startsIn?: number;
      state: MatchState;
      type: "match";
      v: typeof SIGNALING_PROTOCOL_VERSION;
    }
  | {
      signal: WebRtcSignal;
      to: string;
      type: "signal";
      v: typeof SIGNALING_PROTOCOL_VERSION;
    };

type ValidationResult<T> =
  | { ok: true; value: T }
  | { message: string; ok: false };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProtocolVersion(
  value: unknown,
): value is typeof SIGNALING_PROTOCOL_VERSION {
  return value === SIGNALING_PROTOCOL_VERSION;
}

function isPlayerStyle(value: unknown): value is PlayerStyle {
  return (
    typeof value === "string" &&
    (PLAYER_STYLES as readonly string[]).includes(value)
  );
}

export function parsePlayerProfile(
  value: unknown,
): ValidationResult<PlayerProfile> {
  if (!isRecord(value)) {
    return { ok: false, message: "Player profile must be an object." };
  }

  const { name, style } = value;
  if (
    typeof name !== "string" ||
    name !== name.trim() ||
    name.length < 1 ||
    name.length > 11 ||
    !/^[A-Za-z0-9][A-Za-z0-9 ._'-]*$/u.test(name)
  ) {
    return {
      ok: false,
      message:
        "Player name must be 1-11 basic letters, numbers, spaces, or simple punctuation.",
    };
  }
  if (!isPlayerStyle(style)) {
    return { ok: false, message: "Player style is invalid." };
  }
  const { emblem } = value;
  if (emblem !== undefined && (typeof emblem !== "number" || !Number.isInteger(emblem) ||
      emblem < 0 || emblem >= EMBLEM_COUNT)) {
    return { ok: false, message: "Player emblem is invalid." };
  }

  return { ok: true, value: emblem === undefined ? { name, style } : { name, style, emblem } };
}

export function isBuildId(value: unknown): value is string {
  return typeof value === "string" && BUILD_ID_PATTERN.test(value);
}

function turnstileToken(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" && value.length > 0 && value.length <= 2_048 ? value : null;
}

/* An unrecognised token is simply no wallet: the player plays unwagered. */
function walletTokenField(value: unknown): { walletToken?: string } {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value) ? { walletToken: value } : {};
}

function isLobbyIndex(value: unknown, count: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < count;
}

export function parseLobbySettings(value: unknown): ValidationResult<LobbySettings> {
  if (!isRecord(value)) {
    return { ok: false, message: "lobby must be an object." };
  }
  if (!isLobbyIndex(value.mapIndex, LOBBY_MAP_COUNT)) {
    return { ok: false, message: `lobby.mapIndex must be an integer from 0 to ${LOBBY_MAP_COUNT - 1}.` };
  }
  if (!isLobbyIndex(value.modeIndex, LOBBY_MODE_COUNT)) {
    return { ok: false, message: `lobby.modeIndex must be an integer from 0 to ${LOBBY_MODE_COUNT - 1}.` };
  }
  return { ok: true, value: { mapIndex: value.mapIndex, modeIndex: value.modeIndex } };
}

export function parseCreateRoomInput(
  value: unknown,
): ValidationResult<CreateRoomInput> {
  if (!isRecord(value)) {
    return { ok: false, message: "Body must be a JSON object." };
  }
  if (!isProtocolVersion(value.protocolVersion)) {
    return { ok: false, message: "Unsupported protocolVersion." };
  }
  if (!isBuildId(value.buildId)) {
    return {
      ok: false,
      message: "buildId must be 1-96 URL-safe characters.",
    };
  }
  if (
    typeof value.identifier !== "string" ||
    !IDENTIFIER_PATTERN.test(value.identifier)
  ) {
    return {
      ok: false,
      message: "identifier must be exactly 12 lowercase hexadecimal characters.",
    };
  }
  const verifiedToken = turnstileToken(value.turnstileToken);
  if (verifiedToken === null) return { ok: false, message: "turnstileToken is malformed." };
  if (
    value.capacity !== undefined &&
    (!Number.isInteger(value.capacity) ||
      typeof value.capacity !== "number" ||
      value.capacity < 2)
  ) {
    return { ok: false, message: "capacity must be an integer of at least 2." };
  }
  if (
    value.visibility !== undefined &&
    value.visibility !== "private" &&
    value.visibility !== "public"
  ) {
    return { ok: false, message: "visibility must be \"private\" or \"public\"." };
  }
  if (value.dedicated !== undefined && typeof value.dedicated !== "boolean") {
    return { ok: false, message: "dedicated must be a boolean." };
  }
  let lobby: LobbySettings | undefined;
  if (value.lobby !== undefined) {
    const parsedLobby = parseLobbySettings(value.lobby);
    if (!parsedLobby.ok) return parsedLobby;
    lobby = parsedLobby.value;
  }

  return {
    ok: true,
    value: {
      buildId: value.buildId,
      ...(value.capacity === undefined ? {} : { capacity: value.capacity }),
      ...(value.dedicated === undefined ? {} : { dedicated: value.dedicated }),
      identifier: value.identifier,
      ...(lobby === undefined ? {} : { lobby }),
      protocolVersion: value.protocolVersion,
      ...(verifiedToken === undefined ? {} : { turnstileToken: verifiedToken }),
      ...(value.visibility === undefined ? {} : { visibility: value.visibility }),
      ...walletTokenField(value.walletToken),
    },
  };
}

export function parseQuickJoinInput(
  value: unknown,
): ValidationResult<QuickJoinInput> {
  if (!isRecord(value)) {
    return { ok: false, message: "Body must be a JSON object." };
  }
  if (!isProtocolVersion(value.protocolVersion)) {
    return { ok: false, message: "Unsupported protocolVersion." };
  }
  if (!isBuildId(value.buildId)) {
    return {
      ok: false,
      message: "buildId must be 1-96 URL-safe characters.",
    };
  }
  if (
    typeof value.identifier !== "string" ||
    !IDENTIFIER_PATTERN.test(value.identifier)
  ) {
    return {
      ok: false,
      message: "identifier must be exactly 12 lowercase hexadecimal characters.",
    };
  }
  const verifiedToken = turnstileToken(value.turnstileToken);
  if (verifiedToken === null) return { ok: false, message: "turnstileToken is malformed." };
  let modes: number[] | undefined;
  if (value.modes !== undefined) {
    if (!Array.isArray(value.modes) || value.modes.length === 0 || value.modes.length > LOBBY_MODE_COUNT ||
        !value.modes.every((mode) => isLobbyIndex(mode, LOBBY_MODE_COUNT))) {
      return { ok: false, message: "modes must list game types." };
    }
    modes = value.modes as number[];
  }
  return {
    ok: true,
    value: {
      buildId: value.buildId,
      identifier: value.identifier,
      protocolVersion: value.protocolVersion,
      ...(verifiedToken === undefined ? {} : { turnstileToken: verifiedToken }),
      ...walletTokenField(value.walletToken),
      ...(value.serversOnly === true ? { serversOnly: true } : {}),
      ...(modes ? { modes } : {}),
      ...(value.spectator === true ? { spectator: true } : {}),
    },
  };
}

export function parseCreateSessionInput(
  value: unknown,
): ValidationResult<CreateSessionInput> {
  if (!isRecord(value)) {
    return { ok: false, message: "Body must be a JSON object." };
  }
  if (!isProtocolVersion(value.protocolVersion)) {
    return { ok: false, message: "Unsupported protocolVersion." };
  }
  if (!isBuildId(value.buildId)) {
    return {
      ok: false,
      message: "buildId must be 1-96 URL-safe characters.",
    };
  }
  if (
    typeof value.identifier !== "string" ||
    !IDENTIFIER_PATTERN.test(value.identifier)
  ) {
    return {
      ok: false,
      message: "identifier must be exactly 12 lowercase hexadecimal characters.",
    };
  }
  /* A public room's guests need no ticket; the room object enforces that a
     ticket-less session is only ever minted for a public room. */
  if (
    value.ticket !== undefined &&
    (typeof value.ticket !== "string" || !TOKEN_PATTERN.test(value.ticket))
  ) {
    return { ok: false, message: "ticket is malformed." };
  }
  const verifiedToken = turnstileToken(value.turnstileToken);
  if (verifiedToken === null) return { ok: false, message: "turnstileToken is malformed." };

  return {
    ok: true,
    value: {
      buildId: value.buildId,
      identifier: value.identifier,
      protocolVersion: value.protocolVersion,
      ...(value.ticket === undefined ? {} : { ticket: value.ticket }),
      ...(verifiedToken === undefined ? {} : { turnstileToken: verifiedToken }),
      ...walletTokenField(value.walletToken),
    },
  };
}

function parseDescriptionSignal(value: Record<string, unknown>): WebRtcSignal | null {
  if (value.kind !== "description" || !isRecord(value.description)) {
    return null;
  }
  const { sdp, type } = value.description;
  if (
    (type !== "offer" && type !== "answer") ||
    typeof sdp !== "string" ||
    !/^v=0(?:\r\n|\n)/u.test(sdp) ||
    sdp.length > 32_768
  ) {
    return null;
  }
  return { description: { sdp, type }, kind: "description" };
}

function nullableShortString(
  value: unknown,
  maximumLength: number,
): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && value.length <= maximumLength)
  );
}

function parseCandidateSignal(value: Record<string, unknown>): WebRtcSignal | null {
  if (value.kind !== "candidate") {
    return null;
  }
  if (value.candidate === null) {
    return { candidate: null, kind: "candidate" };
  }
  if (!isRecord(value.candidate)) {
    return null;
  }

  const candidate = value.candidate;
  if (
    typeof candidate.candidate !== "string" ||
    candidate.candidate.length > 4_096 ||
    !nullableShortString(candidate.sdpMid, 256) ||
    !(
      candidate.sdpMLineIndex === null ||
      (typeof candidate.sdpMLineIndex === "number" &&
        Number.isInteger(candidate.sdpMLineIndex) &&
        candidate.sdpMLineIndex >= 0 &&
        candidate.sdpMLineIndex <= 65_535)
    ) ||
    (candidate.usernameFragment !== undefined &&
      !nullableShortString(candidate.usernameFragment, 256))
  ) {
    return null;
  }

  return {
    candidate: {
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid,
      sdpMLineIndex: candidate.sdpMLineIndex,
      ...(candidate.usernameFragment === undefined
        ? {}
        : { usernameFragment: candidate.usernameFragment }),
    },
    kind: "candidate",
  };
}

export function parseClientMessage(value: unknown): ValidationResult<ClientMessage> {
  if (!isRecord(value) || !isProtocolVersion(value.v)) {
    return { ok: false, message: "Invalid signaling envelope." };
  }

  if (value.type === "ping") {
    if (
      value.nonce !== undefined &&
      (typeof value.nonce !== "string" || value.nonce.length > 64)
    ) {
      return { ok: false, message: "Ping nonce is invalid." };
    }
    return {
      ok: true,
      value: {
        ...(value.nonce === undefined ? {} : { nonce: value.nonce }),
        type: "ping",
        v: SIGNALING_PROTOCOL_VERSION,
      },
    };
  }

  if (value.type === "kill") {
    const killer = parsePlayerProfile({ name: value.killer, style: "sage" });
    const victim = parsePlayerProfile({ name: value.victim, style: "sage" });
    if (!killer.ok || !victim.ok) return { ok: false, message: "Kill names are invalid." };
    return {
      ok: true,
      value: { killer: killer.value.name, type: "kill", v: SIGNALING_PROTOCOL_VERSION, victim: victim.value.name },
    };
  }

  if (value.type === "waiting") {
    return { ok: true, value: { type: "waiting", v: SIGNALING_PROTOCOL_VERSION } };
  }

  if (value.type === "pings") {
    if (!isRecord(value.pings)) return { ok: false, message: "Pings are invalid." };
    const entries = Object.entries(value.pings);
    if (entries.length > 64 || !entries.every(([peerId, ping]) =>
      PEER_ID_PATTERN.test(peerId) && Number.isInteger(ping) && (ping as number) >= 0 && (ping as number) <= 60_000)) {
      return { ok: false, message: "Pings are invalid." };
    }
    return { ok: true, value: { pings: Object.fromEntries(entries) as Record<string, number>, type: "pings", v: SIGNALING_PROTOCOL_VERSION } };
  }

  if (value.type === "match") {
    if (typeof value.state !== "string" || !(MATCH_STATES as readonly string[]).includes(value.state)) {
      return { ok: false, message: "Match state is invalid." };
    }
    if (
      value.startsIn !== undefined &&
      (typeof value.startsIn !== "number" || !Number.isInteger(value.startsIn) ||
        value.startsIn < 0 || value.startsIn > 255)
    ) {
      return { ok: false, message: "startsIn must be an integer from 0 to 255." };
    }
    return {
      ok: true,
      value: {
        ...(value.startsIn === undefined ? {} : { startsIn: value.startsIn }),
        state: value.state as MatchState,
        type: "match",
        v: SIGNALING_PROTOCOL_VERSION,
      },
    };
  }

  if (value.type === "profile") {
    const profile = parsePlayerProfile(value.profile);
    if (!profile.ok) {
      return profile;
    }
    return {
      ok: true,
      value: {
        profile: profile.value,
        type: "profile",
        v: SIGNALING_PROTOCOL_VERSION,
      },
    };
  }

  if (
    value.type !== "signal" ||
    typeof value.to !== "string" ||
    !PEER_ID_PATTERN.test(value.to) ||
    !isRecord(value.signal)
  ) {
    return { ok: false, message: "Invalid signal message." };
  }

  const signal =
    parseDescriptionSignal(value.signal) ?? parseCandidateSignal(value.signal);
  if (signal === null) {
    return { ok: false, message: "Invalid WebRTC signal payload." };
  }

  return {
    ok: true,
    value: {
      signal,
      to: value.to,
      type: "signal",
      v: SIGNALING_PROTOCOL_VERSION,
    },
  };
}
