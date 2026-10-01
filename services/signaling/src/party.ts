import { DurableObject } from "cloudflare:workers";

import { randomToken } from "./crypto";

/* A party: friends together in the lobby, by a short code anyone can share
   (a link with #party=CODE, or typed in). One Durable Object per code.

   Every member's page polls the party about once a second; the poll keeps
   them in it, and a member not heard from in a while drops out. The first
   member leads; when the leader goes, the longest-standing member leads.
   The leader picks the lobby (matchmaking, or a custom game with its map
   and game type) and starts it. Starting gives every member a matchmaker
   ticket (src/matchmaker.ts: enqueueParty, startCustom), which each page
   then follows as it follows its own. */

export const PARTY_MAXIMUM_MEMBERS = 16;
/* a member not heard from in this long has left */
const MEMBER_TIMEOUT_MS = 20_000;
const RECORD_KEY = "party";

export type PartyLobby = "matchmaking" | "custom";

export interface PartyProfile {
  name: string;
  style: string;
  emblem: number | null;
}

export interface PartyJoin {
  /* the browser's lasting player key: private to the member */
  key: string;
  identifier: string;
  wallet: string | null;
  profile: PartyProfile;
}

interface PartyMember extends PartyJoin {
  /* what other members see instead of the key */
  id: string;
  joinedAt: number;
  seenAt: number;
}

export interface PartyActivity {
  id: string;
  kind: "queue" | "custom";
  playlist: string;
  tickets: Record<string, string>;
  at: number;
}

interface PartyRecord {
  code: string;
  buildId: string;
  leader: string;
  members: PartyMember[];
  lobby: PartyLobby;
  playlist: string;
  mapIndex: number;
  modeIndex: number;
  activity: PartyActivity | null;
  createdAt: number;
}

export interface PartySettings {
  lobby?: PartyLobby;
  playlist?: string;
  mapIndex?: number;
  modeIndex?: number;
}

/* What a member sees: everyone's public face, the settings, and their own
   ticket in the party's current activity. */
export interface PartyView {
  code: string;
  leader: boolean;
  self: string;
  members: Array<PartyProfile & { id: string; leader: boolean; self: boolean }>;
  lobby: PartyLobby;
  playlist: string;
  mapIndex: number;
  modeIndex: number;
  activity: { id: string; kind: "queue" | "custom"; playlist: string; ticket: string | null; at: number } | null;
}

export type PartyResult = { party: PartyView } | { error: "NOT_FOUND" | "FULL" | "NOT_MEMBER" | "NOT_LEADER" };

export class Party extends DurableObject<Env> {
  private read(): PartyRecord | null {
    return (this.ctx.storage.kv.get(RECORD_KEY) as PartyRecord | undefined) ?? null;
  }

  private write(record: PartyRecord): void {
    this.ctx.storage.kv.put(RECORD_KEY, record);
  }

  /* Members not heard from lately leave; the leader passes on; an empty
     party is gone. */
  private prune(record: PartyRecord, now: number): PartyRecord | null {
    record.members = record.members.filter((member) => now - member.seenAt <= MEMBER_TIMEOUT_MS);
    if (record.members.length === 0) {
      this.ctx.storage.kv.delete(RECORD_KEY);
      return null;
    }
    if (!record.members.some((member) => member.key === record.leader)) {
      record.leader = [...record.members].sort((left, right) => left.joinedAt - right.joinedAt)[0]!.key;
    }
    return record;
  }

  private view(record: PartyRecord, key: string): PartyView {
    const self = record.members.find((member) => member.key === key)!;
    return {
      code: record.code,
      leader: record.leader === key,
      self: self.id,
      members: record.members.map((member) => ({
        id: member.id,
        name: member.profile.name,
        style: member.profile.style,
        emblem: member.profile.emblem,
        leader: member.key === record.leader,
        self: member.key === key,
      })),
      lobby: record.lobby,
      playlist: record.playlist,
      mapIndex: record.mapIndex,
      modeIndex: record.modeIndex,
      activity: record.activity ? {
        id: record.activity.id,
        kind: record.activity.kind,
        playlist: record.activity.playlist,
        ticket: record.activity.tickets[key] ?? null,
        at: record.activity.at,
      } : null,
    };
  }

  private upsert(record: PartyRecord, join: PartyJoin, now: number): PartyMember {
    const existing = record.members.find((member) => member.key === join.key);
    if (existing) {
      existing.identifier = join.identifier;
      existing.wallet = join.wallet;
      existing.profile = join.profile;
      existing.seenAt = now;
      return existing;
    }
    const member: PartyMember = { ...join, id: randomToken(8), joinedAt: now, seenAt: now };
    record.members.push(member);
    return member;
  }

  /* A new party, its creator leading; false if the code is taken. */
  async create(
    code: string, buildId: string, join: PartyJoin, settings: Required<PartySettings>, now: number,
  ): Promise<PartyView | null> {
    const existing = this.read();
    if (existing && this.prune(existing, now)) return null;
    const record: PartyRecord = {
      code, buildId, leader: join.key, members: [], ...settings, activity: null, createdAt: now,
    };
    this.upsert(record, join, now);
    this.write(record);
    return this.view(record, join.key);
  }

  async join(join: PartyJoin, now: number): Promise<PartyResult> {
    const record = this.read();
    const live = record ? this.prune(record, now) : null;
    if (!live) return { error: "NOT_FOUND" };
    if (!live.members.some((member) => member.key === join.key) && live.members.length >= PARTY_MAXIMUM_MEMBERS) {
      return { error: "FULL" };
    }
    this.upsert(live, join, now);
    this.write(live);
    return { party: this.view(live, join.key) };
  }

  /* A member's poll: they are still here. */
  async poll(join: PartyJoin, now: number): Promise<PartyResult> {
    const record = this.read();
    const live = record ? this.prune(record, now) : null;
    if (!live) return { error: "NOT_FOUND" };
    if (!live.members.some((member) => member.key === join.key)) {
      this.write(live);
      return { error: "NOT_MEMBER" };
    }
    this.upsert(live, join, now);
    this.write(live);
    return { party: this.view(live, join.key) };
  }

  async leave(key: string, now: number): Promise<void> {
    const record = this.read();
    if (!record) return;
    record.members = record.members.filter((member) => member.key !== key);
    const live = this.prune(record, now);
    if (live) this.write(live);
  }

  /* The leader changes the lobby, playlist, map or game type. */
  async configure(key: string, settings: PartySettings, now: number): Promise<PartyResult> {
    const record = this.read();
    const live = record ? this.prune(record, now) : null;
    if (!live) return { error: "NOT_FOUND" };
    if (live.leader !== key) return { error: "NOT_LEADER" };
    if (settings.lobby) live.lobby = settings.lobby;
    if (settings.playlist) live.playlist = settings.playlist;
    if (settings.mapIndex !== undefined) live.mapIndex = settings.mapIndex;
    if (settings.modeIndex !== undefined) live.modeIndex = settings.modeIndex;
    this.write(live);
    return { party: this.view(live, key) };
  }

  /* The members the leader starts with: everyone here now. */
  async startingMembers(key: string, now: number): Promise<
    { members: Array<{ key: string; identifier: string; wallet: string | null; name: string }>; record: Pick<PartyRecord, "buildId" | "lobby" | "playlist" | "mapIndex" | "modeIndex"> } |
    { error: "NOT_FOUND" | "NOT_LEADER" }
  > {
    const record = this.read();
    const live = record ? this.prune(record, now) : null;
    if (!live) return { error: "NOT_FOUND" };
    if (live.leader !== key) return { error: "NOT_LEADER" };
    this.write(live);
    return {
      members: live.members.map((member) => ({
        key: member.key, identifier: member.identifier, wallet: member.wallet, name: member.profile.name,
      })),
      record: { buildId: live.buildId, lobby: live.lobby, playlist: live.playlist, mapIndex: live.mapIndex, modeIndex: live.modeIndex },
    };
  }

  /* The party's current activity: its members' tickets, or none. */
  async setActivity(key: string, activity: Omit<PartyActivity, "id" | "at"> | null, now: number): Promise<PartyResult> {
    const record = this.read();
    const live = record ? this.prune(record, now) : null;
    if (!live) return { error: "NOT_FOUND" };
    if (live.leader !== key) return { error: "NOT_LEADER" };
    live.activity = activity ? { ...activity, id: randomToken(8), at: now } : null;
    this.write(live);
    return { party: this.view(live, key) };
  }
}
