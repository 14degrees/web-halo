import { DurableObject } from "cloudflare:workers";

import { BadgeCache, BADGE_LOOKUP_TTL_MS, badgeFields, type PlayerBadges } from "./badges";
import { PARTY_CHAT_HISTORY, allowChat, censorChatText } from "./chat";
import { randomToken } from "./crypto";
import type { CustomStakes } from "./matchmaker";

/* A party: friends together in the lobby, by a short code anyone can share
   (a link with #party=CODE, or typed in). One Durable Object per code.

   Every member's page polls the party about once a second; the poll keeps
   them in it, and a member not heard from in a while drops out. The first
   member leads; when the leader goes, the longest-standing member leads.
   The leader picks the lobby (matchmaking, or a custom game with its map
   and game type) and starts it. Starting gives every member a matchmaker
   ticket (src/matchmaker.ts: enqueueParty, startCustom), which each page
   then follows as it follows its own.

   Money: the leader picks the stake of a playlist for SOL, or a custom
   game's stake, kill target and team share. Those terms are numbered; any
   change to them (or to the lobby, playlist or game type, which change
   what they mean) starts a new number, which only the leader has
   accepted. Every member must accept the current terms before the party
   starts anything that stakes, so nobody stakes on terms they didn't see.

   Members wear the badges of the wallet they signed in with (src/badges.ts):
   their account name and shown links, looked up after a poll and asked
   again only every BADGE_LOOKUP_TTL_MS.

   Members chat by text while they wait (src/chat.ts): a message is kept
   with the party, numbered, and a poll brings back the ones after the
   number the member saw last. The party's last PARTY_CHAT_HISTORY messages
   go with it when it ends. */

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
  /* text chat: how often this member has spoken lately (src/chat.ts) */
  chatCount?: number;
  chatWindowStartedAt?: number;
  /* the wallet's badges (src/badges.ts), and when the party last asked */
  badges?: PlayerBadges;
  badgesAt?: number;
}

/* a line of chat, as members see it: who (their member id, name and
   colour), what, when, and its number in the party's chat */
export interface PartyChatMessage {
  seq: number;
  from: string;
  name: string;
  style: string;
  text: string;
  at: number;
  /* the speaker's badges then (src/badges.ts) */
  username?: string;
  links?: PlayerBadges["links"];
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
  /* a playlist for SOL: the leader's stake tier (null: its default) */
  stake?: number | null;
  /* a custom game for SOL: its terms (null: a free game) */
  customStakes?: CustomStakes | null;
  /* the terms' number, and the members (by key) who accepted them */
  terms?: number;
  accepted?: string[];
  /* the last PARTY_CHAT_HISTORY lines of chat (absent in parties made
     before chat) */
  chat?: PartyChatMessage[];
  chatSeq?: number;
}

export interface PartySettings {
  lobby?: PartyLobby;
  playlist?: string;
  mapIndex?: number;
  modeIndex?: number;
  stake?: number | null;
  customStakes?: CustomStakes | null;
}

/* What a member sees: everyone's public face, the settings, and their own
   ticket in the party's current activity. */
export interface PartyView {
  code: string;
  leader: boolean;
  self: string;
  members: Array<PartyProfile & PlayerBadges & { id: string; leader: boolean; self: boolean; accepted: boolean }>;
  lobby: PartyLobby;
  playlist: string;
  mapIndex: number;
  modeIndex: number;
  stake: number | null;
  customStakes: CustomStakes | null;
  /* the terms' number, for accept */
  terms: number;
  activity: { id: string; kind: "queue" | "custom"; playlist: string; ticket: string | null; at: number } | null;
  /* the chat after the line the member saw last (chatSince), oldest first */
  chat: PartyChatMessage[];
}

export type PartyResult =
  | { party: PartyView }
  | { error: "NOT_FOUND" | "FULL" | "NOT_MEMBER" | "NOT_LEADER" | "CHAT_RATE_LIMITED" | "TERMS_CHANGED" };

const sameStakes = (left: CustomStakes | null, right: CustomStakes | null): boolean =>
  left === right || (left !== null && right !== null && left.stake === right.stake &&
    left.killTarget === right.killTarget && left.teamShareBps === right.teamShareBps);

export class Party extends DurableObject<Env> {
  private readonly badges = new BadgeCache(this.env);

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

  private view(record: PartyRecord, key: string, chatSince = 0): PartyView {
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
        accepted: member.key === record.leader || (record.accepted ?? []).includes(member.key),
        ...badgeFields(member.badges ?? {}),
      })),
      lobby: record.lobby,
      playlist: record.playlist,
      mapIndex: record.mapIndex,
      modeIndex: record.modeIndex,
      stake: record.stake ?? null,
      customStakes: record.customStakes ?? null,
      terms: record.terms ?? 0,
      activity: record.activity ? {
        id: record.activity.id,
        kind: record.activity.kind,
        playlist: record.activity.playlist,
        ticket: record.activity.tickets[key] ?? null,
        at: record.activity.at,
      } : null,
      chat: (record.chat ?? []).filter((message) => message.seq > chatSince),
    };
  }

  private upsert(record: PartyRecord, join: PartyJoin, now: number): PartyMember {
    const existing = record.members.find((member) => member.key === join.key);
    if (existing) {
      existing.identifier = join.identifier;
      if (existing.wallet !== join.wallet) {
        delete existing.badges;
        delete existing.badgesAt;
      }
      existing.wallet = join.wallet;
      existing.profile = join.profile;
      existing.seenAt = now;
      this.refreshBadges(existing, now);
      return existing;
    }
    const member: PartyMember = { ...join, id: randomToken(8), joinedAt: now, seenAt: now };
    record.members.push(member);
    this.refreshBadges(member, now);
    return member;
  }

  /* A member's badges, when they are due: asked for after the answer, and
     kept on the member for everyone's next poll. */
  private refreshBadges(member: PartyMember, now: number): void {
    const wallet = member.wallet;
    if (wallet === null || (member.badgesAt !== undefined && now - member.badgesAt < BADGE_LOOKUP_TTL_MS)) return;
    member.badgesAt = now;
    const key = member.key;
    this.ctx.waitUntil((async () => {
      const badges = (await this.badges.lookUp([wallet], now)).get(wallet);
      const record = this.read();
      const current = record?.members.find((candidate) => candidate.key === key && candidate.wallet === wallet);
      if (!record || !current) return;
      if (badges === undefined) delete current.badgesAt;
      else current.badges = badges;
      this.write(record);
    })());
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

  async join(join: PartyJoin, now: number, chatSince = 0): Promise<PartyResult> {
    const record = this.read();
    const live = record ? this.prune(record, now) : null;
    if (!live) return { error: "NOT_FOUND" };
    if (!live.members.some((member) => member.key === join.key) && live.members.length >= PARTY_MAXIMUM_MEMBERS) {
      return { error: "FULL" };
    }
    this.upsert(live, join, now);
    this.write(live);
    return { party: this.view(live, join.key, chatSince) };
  }

  /* A member's poll: they are still here. */
  async poll(join: PartyJoin, now: number, chatSince = 0): Promise<PartyResult> {
    const record = this.read();
    const live = record ? this.prune(record, now) : null;
    if (!live) return { error: "NOT_FOUND" };
    if (!live.members.some((member) => member.key === join.key)) {
      this.write(live);
      return { error: "NOT_MEMBER" };
    }
    this.upsert(live, join, now);
    this.write(live);
    return { party: this.view(live, join.key, chatSince) };
  }

  /* A member says something to the party. The text arrives checked
     (src/chat.ts, normaliseChatText); the party masks the profanity, holds
     a flood back, and keeps the last lines for the others' polls. */
  async say(join: PartyJoin, text: string, now: number, chatSince = 0): Promise<PartyResult> {
    const record = this.read();
    const live = record ? this.prune(record, now) : null;
    if (!live) return { error: "NOT_FOUND" };
    if (!live.members.some((member) => member.key === join.key)) {
      this.write(live);
      return { error: "NOT_MEMBER" };
    }
    const member = this.upsert(live, join, now);
    if (!allowChat(member, now)) {
      this.write(live);
      return { error: "CHAT_RATE_LIMITED" };
    }
    const seq = (live.chatSeq ?? 0) + 1;
    live.chatSeq = seq;
    live.chat = [...(live.chat ?? []), {
      seq, from: member.id, name: member.profile.name, style: member.profile.style, text: censorChatText(text), at: now,
      ...badgeFields(member.badges ?? {}),
    }].slice(-PARTY_CHAT_HISTORY);
    this.write(live);
    return { party: this.view(live, join.key, chatSince) };
  }

  async leave(key: string, now: number): Promise<void> {
    const record = this.read();
    if (!record) return;
    record.members = record.members.filter((member) => member.key !== key);
    const live = this.prune(record, now);
    if (live) this.write(live);
  }

  /* The leader changes the lobby, playlist, map, game type or stakes; a
     change to the terms needs everyone's acceptance again. */
  async configure(key: string, settings: PartySettings, now: number): Promise<PartyResult> {
    const record = this.read();
    const live = record ? this.prune(record, now) : null;
    if (!live) return { error: "NOT_FOUND" };
    if (live.leader !== key) return { error: "NOT_LEADER" };
    const changed = (settings.lobby !== undefined && settings.lobby !== live.lobby) ||
      (settings.playlist !== undefined && settings.playlist !== live.playlist) ||
      (settings.modeIndex !== undefined && settings.modeIndex !== live.modeIndex) ||
      (settings.stake !== undefined && settings.stake !== (live.stake ?? null)) ||
      (settings.customStakes !== undefined && !sameStakes(settings.customStakes, live.customStakes ?? null));
    if (settings.lobby) live.lobby = settings.lobby;
    if (settings.playlist) live.playlist = settings.playlist;
    if (settings.mapIndex !== undefined) live.mapIndex = settings.mapIndex;
    if (settings.modeIndex !== undefined) live.modeIndex = settings.modeIndex;
    if (settings.stake !== undefined) live.stake = settings.stake;
    if (settings.customStakes !== undefined) live.customStakes = settings.customStakes;
    if (changed) {
      live.terms = (live.terms ?? 0) + 1;
      live.accepted = [];
    }
    this.write(live);
    return { party: this.view(live, key) };
  }

  /* A member accepts the terms they were shown (by number): stale terms
     are refused, so an acceptance never carries over to a change. */
  async accept(join: PartyJoin, terms: number, now: number): Promise<PartyResult> {
    const record = this.read();
    const live = record ? this.prune(record, now) : null;
    if (!live) return { error: "NOT_FOUND" };
    if (!live.members.some((member) => member.key === join.key)) {
      this.write(live);
      return { error: "NOT_MEMBER" };
    }
    this.upsert(live, join, now);
    if (terms !== (live.terms ?? 0)) {
      this.write(live);
      return { error: "TERMS_CHANGED" };
    }
    live.accepted = [...new Set([...(live.accepted ?? []), join.key])];
    this.write(live);
    return { party: this.view(live, join.key) };
  }

  /* The members the leader starts with: everyone here now. */
  async startingMembers(key: string, now: number): Promise<
    {
      members: Array<{ key: string; identifier: string; wallet: string | null; name: string; accepted: boolean }>;
      record: Pick<PartyRecord, "buildId" | "lobby" | "playlist" | "mapIndex" | "modeIndex"> &
        { stake: number | null; customStakes: CustomStakes | null };
    } |
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
        accepted: member.key === live.leader || (live.accepted ?? []).includes(member.key),
      })),
      record: {
        buildId: live.buildId, lobby: live.lobby, playlist: live.playlist, mapIndex: live.mapIndex,
        modeIndex: live.modeIndex, stake: live.stake ?? null, customStakes: live.customStakes ?? null,
      },
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
