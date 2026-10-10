import { PROFILES_NAME, type PublicProfileView } from "./profiles";

/* A player's badges on a roster: their account name and the links they
   show (src/profiles.ts, publicView: only verified links whose owner turned
   on showFomo or showX). The room and the party attach them from the wallet
   they signed in with, so a client can never name its own; whatever a page
   sends about itself is ignored.

   A fomo badge carries the handle only once an admin confirmed it; until
   then it says "fomo wallet" and links nowhere. No wallet address goes out
   with a badge. */

export interface PlayerLinks {
  fomo?: { handle: string | null };
  x?: { handle: string };
}

export interface PlayerBadges {
  username?: string;
  links?: PlayerLinks;
}

/* how long a lookup stands before the room or party asks again: a player
   who changes what they show sees it on the next look after this */
export const BADGE_LOOKUP_TTL_MS = 5 * 60_000;
/* the most wallets a room keeps answers for */
const BADGE_CACHE_LIMIT = 256;

export function badgesFromView(view: PublicProfileView | undefined): PlayerBadges {
  if (view === undefined) return {};
  const links: PlayerLinks = {};
  if (view.fomo !== undefined) links.fomo = { handle: view.fomo.handle };
  if (view.x !== undefined) links.x = { handle: view.x.handle };
  return { username: view.username, ...(links.fomo || links.x ? { links } : {}) };
}

/* the badges as a message carries them: nothing when there are none */
export function badgeFields(badges: PlayerBadges): PlayerBadges {
  return {
    ...(badges.username === undefined ? {} : { username: badges.username }),
    ...(badges.links === undefined ? {} : { links: badges.links }),
  };
}

export function isPlayerLinks(value: unknown): value is PlayerLinks {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const fomo = record.fomo as Record<string, unknown> | undefined;
  const x = record.x as Record<string, unknown> | undefined;
  return (fomo === undefined || (typeof fomo === "object" && fomo !== null &&
      (fomo.handle === null || typeof fomo.handle === "string"))) &&
    (x === undefined || (typeof x === "object" && x !== null && typeof x.handle === "string"));
}

/* The public badges behind some wallets, from the Profiles store, with the
   answers kept for BADGE_LOOKUP_TTL_MS so a room or party asks once per
   player, not per message or poll. A wallet with no profile is kept too
   (as no badges). The store being down answers nothing and keeps nothing. */
export class BadgeCache {
  private readonly entries = new Map<string, { badges: PlayerBadges; at: number }>();

  constructor(private readonly env: Pick<Env, "PROFILES">) {}

  fresh(wallet: string, now: number): PlayerBadges | undefined {
    const entry = this.entries.get(wallet);
    return entry !== undefined && now - entry.at < BADGE_LOOKUP_TTL_MS ? entry.badges : undefined;
  }

  async lookUp(wallets: string[], now: number): Promise<Map<string, PlayerBadges>> {
    const out = new Map<string, PlayerBadges>();
    const missing: string[] = [];
    for (const wallet of new Set(wallets)) {
      const known = this.fresh(wallet, now);
      if (known === undefined) missing.push(wallet);
      else out.set(wallet, known);
    }
    if (missing.length === 0) return out;
    let views: Record<string, PublicProfileView>;
    try {
      views = await this.env.PROFILES.getByName(PROFILES_NAME).publicProfilesForWallets(missing);
    } catch {
      return out;
    }
    for (const wallet of missing) {
      const badges = badgesFromView(views[wallet]);
      this.entries.delete(wallet);
      this.entries.set(wallet, { badges, at: now });
      out.set(wallet, badges);
    }
    while (this.entries.size > BADGE_CACHE_LIMIT) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    return out;
  }
}
