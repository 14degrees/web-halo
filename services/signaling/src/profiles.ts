import { DurableObject } from "cloudflare:workers";

import { randomToken } from "./crypto";

/* Profiles: one singleton Durable Object that holds every player's account.

   A profile is a stable id with one username and one or more wallets.
   Usernames are unique, case-insensitively, across the game. The username
   is the profile's public name; the profile id never changes, so a name
   can later move between profiles (a sale for SOL, an admin transfer)
   without touching anything that points at the profile. The `usernames`
   registry is the source of uniqueness and keeps a name's owner history;
   `profiles.username` is a copy for reads.

   Wallets are the only way in: a wallet signs in (src/wallet.ts), and the
   wallet's profile is the caller's. A wallet belongs to at most one
   profile. The first wallet is linked by the sign-in that claims the
   username; every further wallet proves itself with a signed message
   (src/profile.ts). A profile keeps at least one wallet.

   fomo: the Worker checks each wallet against mainnet (src/fomo.ts) and
   records the answer here, per wallet, in `fomo_checks`; a profile with a
   detected wallet is verified with method "fee_payer". The X columns are
   filled by later work (the X tweet proof); this object only stores and
   shows them. Every link is private until its owner turns on showing it.
   Other players see a profile's links only when they are both shown and
   verified. */

export const PROFILES_NAME = "main";

export const USERNAME_MIN_LENGTH = 3;
/* Halo's own player-name field holds 11 characters, so a username can be a
   player's in-game name as it is. Raising the limit later is free;
   lowering it would orphan names. */
export const USERNAME_MAX_LENGTH = 11;
export const USERNAME_PATTERN = /^[A-Za-z0-9_]+$/u;
/* Names that would impersonate the game or its staff, or read as nobody. */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  "admin", "anonymous", "bot", "bungie", "fomo", "guest", "halo", "host", "mod", "moderator",
  "nobody", "null", "official", "owner", "root", "server", "spartan", "staff", "support", "system", "undefined",
]);
/* a profile may change its username this many times in a day */
export const USERNAME_CHANGES_PER_DAY = 3;
const DAY_MS = 24 * 60 * 60_000;
/* a name a profile gave up is held for it this long before anyone else can
   take it */
export const RELEASED_USERNAME_HOLD_MS = 7 * DAY_MS;
/* how far back the admin view and the per-profile event list reach */
const EVENTS_SHOWN = 50;
/* a wallet not seen on fomo is looked at again after this long; a wallet
   once detected stays detected */
export const FOMO_RECHECK_MS = DAY_MS;

export type UsernameProblem = "USERNAME_INVALID" | "USERNAME_RESERVED";

/* The name a player typed, made canonical: `username` is how it is shown,
   `key` how it is compared. Null with the reason when it is not a valid
   name. */
export function normaliseUsername(input: unknown):
  { username: string; key: string } | { problem: UsernameProblem; message: string } {
  if (typeof input !== "string") return { problem: "USERNAME_INVALID", message: "username must be a string." };
  const username = input.trim().replace(/^@/u, "");
  if (username.length < USERNAME_MIN_LENGTH || username.length > USERNAME_MAX_LENGTH) {
    return {
      problem: "USERNAME_INVALID",
      message: `A username is ${USERNAME_MIN_LENGTH} to ${USERNAME_MAX_LENGTH} characters.`,
    };
  }
  if (!USERNAME_PATTERN.test(username)) {
    return { problem: "USERNAME_INVALID", message: "A username has only letters, digits and underscores." };
  }
  if (/^_|_$/u.test(username)) {
    return { problem: "USERNAME_INVALID", message: "A username can't start or end with an underscore." };
  }
  if (!/[A-Za-z]/u.test(username)) {
    return { problem: "USERNAME_INVALID", message: "A username needs at least one letter." };
  }
  const key = username.toLowerCase();
  if (RESERVED_USERNAMES.has(key) || key.startsWith("admin")) {
    return { problem: "USERNAME_RESERVED", message: "That name is reserved." };
  }
  return { username, key };
}

export type FomoMethod = "fee_payer" | "transfer" | "official";

/* what the chain check found for one wallet (src/fomo.ts) */
export interface FomoCheckView {
  wallet: string;
  checkedAt: number;
  detected: boolean;
  /* the transaction that proved it */
  signature: string | null;
}

export interface FomoDetectionInput {
  detected: boolean;
  signature: string | null;
  scanned: number;
}

export interface ProfileVisibility {
  wallets: boolean;
  fomo: boolean;
  x: boolean;
}

/* what the owner sees */
export interface ProfileView {
  id: string;
  username: string;
  createdAt: number;
  updatedAt: number;
  wallets: Array<{ wallet: string; linkedAt: number }>;
  fomo: { handle: string | null; wallet: string | null; verified: boolean; verifiedAt: number | null; method: FomoMethod | null } | null;
  x: { handle: string | null; verified: boolean; verifiedAt: number | null } | null;
  /* the chain check's answer for each linked wallet it has looked at */
  fomoChecks: FomoCheckView[];
  show: ProfileVisibility;
  /* username changes the profile can still make today */
  usernameChangesLeft: number;
}

/* what other players see: the name, and only the links the owner shows
   that are verified */
export interface PublicProfileView {
  id: string;
  username: string;
  wallets?: string[];
  fomo?: { handle: string | null; wallet: string | null };
  x?: { handle: string };
}

export type ProfileError =
  | "PROFILE_NOT_FOUND"
  | "USERNAME_TAKEN"
  | "USERNAME_RATE_LIMITED"
  | "WALLET_ALREADY_LINKED"
  | "WALLET_NOT_LINKED"
  | "PROFILE_LAST_WALLET";

export type ProfileResult = { profile: ProfileView } | { error: ProfileError };

interface ProfileRow extends Record<string, SqlStorageValue> {
  id: string;
  username: string;
  username_key: string;
  fomo_handle: string | null;
  fomo_wallet: string | null;
  fomo_verified_at: number | null;
  fomo_method: string | null;
  x_handle: string | null;
  x_verified_at: number | null;
  x_proof_url: string | null;
  show_wallets: number;
  show_fomo: number;
  show_x: number;
  created_at: number;
  updated_at: number;
}

interface WalletRow extends Record<string, SqlStorageValue> {
  wallet: string;
  profile_id: string;
  linked_at: number;
}

interface FomoCheckRow extends Record<string, SqlStorageValue> {
  wallet: string;
  checked_at: number;
  detected: number;
  signature: string | null;
  scanned: number;
}

interface UsernameRow extends Record<string, SqlStorageValue> {
  username_key: string;
  username: string;
  profile_id: string | null;
  claimed_at: number;
  released_at: number | null;
  released_by: string | null;
}

export interface ProfileEvent {
  id: number;
  at: number;
  kind: string;
  profileId: string | null;
  wallet: string | null;
  /* JSON text, as logged */
  detail: string | null;
}

export interface AdminProfileView {
  profile: ProfileView | null;
  usernames: Array<{ username: string; profileId: string | null; claimedAt: number; releasedAt: number | null }>;
  events: ProfileEvent[];
}

export class Profiles extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        username_key TEXT NOT NULL UNIQUE,
        fomo_handle TEXT,
        fomo_wallet TEXT,
        fomo_verified_at INTEGER,
        fomo_method TEXT,
        x_handle TEXT,
        x_verified_at INTEGER,
        x_proof_url TEXT,
        show_wallets INTEGER NOT NULL DEFAULT 0,
        show_fomo INTEGER NOT NULL DEFAULT 0,
        show_x INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      /* The registry: who holds each name now (profile_id), or who gave
         it up and when (released_*), so a released name is held for its
         old owner for a while. */
      CREATE TABLE IF NOT EXISTS usernames (
        username_key TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        profile_id TEXT,
        claimed_at INTEGER NOT NULL,
        released_at INTEGER,
        released_by TEXT
      );
      /* every change of a name's owner: claim, rename, release, and later
         transfer and sale (with the price) */
      CREATE TABLE IF NOT EXISTS username_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        username_key TEXT NOT NULL,
        username TEXT NOT NULL,
        kind TEXT NOT NULL,
        from_profile_id TEXT,
        to_profile_id TEXT,
        price_lamports INTEGER
      );
      CREATE TABLE IF NOT EXISTS wallets (
        wallet TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        linked_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        profile_id TEXT,
        wallet TEXT,
        detail TEXT
      );
      /* the chain check's answer per wallet (src/fomo.ts), kept whether or
         not the wallet has a profile yet */
      CREATE TABLE IF NOT EXISTS fomo_checks (
        wallet TEXT PRIMARY KEY,
        checked_at INTEGER NOT NULL,
        detected INTEGER NOT NULL DEFAULT 0,
        signature TEXT,
        scanned INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS usernames_profile ON usernames(profile_id);
      CREATE INDEX IF NOT EXISTS username_history_key ON username_history(username_key, at);
      CREATE INDEX IF NOT EXISTS username_history_to ON username_history(to_profile_id, at);
      CREATE INDEX IF NOT EXISTS wallets_profile ON wallets(profile_id, linked_at);
      CREATE INDEX IF NOT EXISTS events_profile ON events(profile_id, id);
      CREATE INDEX IF NOT EXISTS events_wallet ON events(wallet, id);
      CREATE INDEX IF NOT EXISTS profiles_fomo_wallet ON profiles(fomo_wallet);
      CREATE INDEX IF NOT EXISTS profiles_x_handle ON profiles(x_handle);
    `);
  }

  /* ---------- the event log */

  private log(now: number, kind: string, profileId: string | null, wallet: string | null, detail?: unknown): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO events (at, kind, profile_id, wallet, detail) VALUES (?, ?, ?, ?, ?)",
      now, kind, profileId, wallet, detail === undefined ? null : JSON.stringify(detail),
    );
  }

  /* ---------- reads */

  private profileRow(id: string): ProfileRow | null {
    return this.ctx.storage.sql.exec<ProfileRow>("SELECT * FROM profiles WHERE id = ?", id).toArray()[0] ?? null;
  }

  private profileIdForWallet(wallet: string): string | null {
    return this.ctx.storage.sql
      .exec<WalletRow>("SELECT * FROM wallets WHERE wallet = ?", wallet).toArray()[0]?.profile_id ?? null;
  }

  private walletsOf(profileId: string): WalletRow[] {
    return this.ctx.storage.sql
      .exec<WalletRow>("SELECT * FROM wallets WHERE profile_id = ? ORDER BY linked_at, wallet", profileId).toArray();
  }

  private fomoCheckRows(wallets: string[]): FomoCheckRow[] {
    const out: FomoCheckRow[] = [];
    for (const wallet of wallets) {
      const row = this.ctx.storage.sql.exec<FomoCheckRow>("SELECT * FROM fomo_checks WHERE wallet = ?", wallet).toArray()[0];
      if (row !== undefined) out.push(row);
    }
    return out;
  }

  private fomoCheckView(row: FomoCheckRow): FomoCheckView {
    return { wallet: row.wallet, checkedAt: row.checked_at, detected: row.detected === 1, signature: row.signature };
  }

  private usernameChangesSince(profileId: string, since: number): number {
    return Number(this.ctx.storage.sql.exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM username_history WHERE to_profile_id = ? AND kind = 'rename' AND at > ?",
      profileId, since,
    ).toArray()[0]?.n ?? 0);
  }

  private view(row: ProfileRow, now: number): ProfileView {
    return {
      id: row.id,
      username: row.username,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      wallets: this.walletsOf(row.id).map(({ wallet, linked_at }) => ({ wallet, linkedAt: linked_at })),
      fomo: row.fomo_handle === null && row.fomo_wallet === null ? null : {
        handle: row.fomo_handle,
        wallet: row.fomo_wallet,
        verified: row.fomo_verified_at !== null,
        verifiedAt: row.fomo_verified_at,
        method: row.fomo_method as FomoMethod | null,
      },
      x: row.x_handle === null ? null : {
        handle: row.x_handle,
        verified: row.x_verified_at !== null,
        verifiedAt: row.x_verified_at,
      },
      fomoChecks: this.fomoCheckRows(this.walletsOf(row.id).map(({ wallet }) => wallet)).map((check) => this.fomoCheckView(check)),
      show: { wallets: row.show_wallets === 1, fomo: row.show_fomo === 1, x: row.show_x === 1 },
      usernameChangesLeft: Math.max(0, USERNAME_CHANGES_PER_DAY - this.usernameChangesSince(row.id, now - DAY_MS)),
    };
  }

  private publicView(row: ProfileRow): PublicProfileView {
    const out: PublicProfileView = { id: row.id, username: row.username };
    if (row.show_wallets === 1) out.wallets = this.walletsOf(row.id).map(({ wallet }) => wallet);
    if (row.show_fomo === 1 && row.fomo_verified_at !== null) {
      out.fomo = { handle: row.fomo_handle, wallet: row.fomo_wallet };
    }
    if (row.show_x === 1 && row.x_verified_at !== null && row.x_handle !== null) out.x = { handle: row.x_handle };
    return out;
  }

  /* The profile a signed-in wallet belongs to, or null when it has none
     yet. */
  profileForWallet(wallet: string, now: number): ProfileView | null {
    const id = this.profileIdForWallet(wallet);
    const row = id === null ? null : this.profileRow(id);
    return row === null ? null : this.view(row, now);
  }

  /* Another player's view of a profile, by its name. */
  publicProfile(usernameKey: string): PublicProfileView | null {
    const row = this.ctx.storage.sql
      .exec<ProfileRow>("SELECT * FROM profiles WHERE username_key = ?", usernameKey).toArray()[0];
    return row === undefined ? null : this.publicView(row);
  }

  /* The public profiles behind a roster's wallets. A wallet seen playing is
     already public, so each one maps to its name; a profile's other
     wallets show only when it shows them. */
  publicProfilesForWallets(wallets: string[]): Record<string, PublicProfileView> {
    const out: Record<string, PublicProfileView> = {};
    const views = new Map<string, PublicProfileView>();
    for (const wallet of wallets) {
      const id = this.profileIdForWallet(wallet);
      if (id === null) continue;
      let view = views.get(id);
      if (view === undefined) {
        const row = this.profileRow(id);
        if (row === null) continue;
        view = this.publicView(row);
        views.set(id, view);
      }
      out[wallet] = view;
    }
    return out;
  }

  /* ---------- usernames */

  /* Take a username for the wallet's profile; a wallet with no profile gets
     one. A profile already holding the name only changes its case. */
  claimUsername(wallet: string, username: string, key: string, now: number): ProfileResult {
    return this.ctx.storage.transactionSync(() => {
      const existingId = this.profileIdForWallet(wallet);
      const current = this.ctx.storage.sql
        .exec<UsernameRow>("SELECT * FROM usernames WHERE username_key = ?", key).toArray()[0] ?? null;
      const ownedByCaller = current !== null && current.profile_id !== null && current.profile_id === existingId;
      if (current !== null && !ownedByCaller) {
        if (current.profile_id !== null) return { error: "USERNAME_TAKEN" };
        /* released: held for its old owner for a while */
        const held = current.released_at !== null && now - current.released_at < RELEASED_USERNAME_HOLD_MS &&
          current.released_by !== null && current.released_by !== existingId;
        if (held) return { error: "USERNAME_TAKEN" };
      }
      if (existingId !== null && this.usernameChangesSince(existingId, now - DAY_MS) >= USERNAME_CHANGES_PER_DAY) {
        return { error: "USERNAME_RATE_LIMITED" };
      }

      let id = existingId;
      let kind: "claim" | "rename" | "recase";
      if (id === null) {
        id = randomToken(12);
        this.ctx.storage.sql.exec(
          "INSERT INTO profiles (id, username, username_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
          id, username, key, now, now,
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO wallets (wallet, profile_id, linked_at) VALUES (?, ?, ?)", wallet, id, now,
        );
        this.log(now, "profile_created", id, wallet);
        this.log(now, "wallet_linked", id, wallet, { first: true });
        this.syncFomo(id, wallet, now);
        kind = "claim";
      } else {
        const row = this.profileRow(id)!;
        if (row.username_key === key) {
          if (row.username === username) return { profile: this.view(row, now) };
          kind = "recase";
        } else {
          kind = "rename";
          this.ctx.storage.sql.exec(
            "UPDATE usernames SET profile_id = NULL, released_at = ?, released_by = ? WHERE username_key = ?",
            now, id, row.username_key,
          );
          this.ctx.storage.sql.exec(
            "INSERT INTO username_history (at, username_key, username, kind, from_profile_id, to_profile_id) VALUES (?, ?, ?, 'release', ?, NULL)",
            now, row.username_key, row.username, id,
          );
        }
        this.ctx.storage.sql.exec(
          "UPDATE profiles SET username = ?, username_key = ?, updated_at = ? WHERE id = ?", username, key, now, id,
        );
      }
      if (kind === "recase") {
        this.ctx.storage.sql.exec("UPDATE usernames SET username = ? WHERE username_key = ?", username, key);
      } else {
        this.ctx.storage.sql.exec(
          `INSERT INTO usernames (username_key, username, profile_id, claimed_at, released_at, released_by)
           VALUES (?, ?, ?, ?, NULL, NULL)
           ON CONFLICT(username_key) DO UPDATE SET username = excluded.username, profile_id = excluded.profile_id,
             claimed_at = excluded.claimed_at, released_at = NULL, released_by = NULL`,
          key, username, id, now,
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO username_history (at, username_key, username, kind, from_profile_id, to_profile_id) VALUES (?, ?, ?, ?, ?, ?)",
          now, key, username, kind, current?.released_by ?? null, id,
        );
      }
      this.log(now, `username_${kind}`, id, wallet, { username });
      return { profile: this.view(this.profileRow(id)!, now) };
    });
  }

  /* ---------- wallets */

  /* Add a wallet (already proven by its signature) to the caller's profile. */
  linkWallet(ownerWallet: string, wallet: string, now: number): ProfileResult {
    return this.ctx.storage.transactionSync(() => {
      const id = this.profileIdForWallet(ownerWallet);
      if (id === null) return { error: "PROFILE_NOT_FOUND" };
      if (this.profileIdForWallet(wallet) !== null) return { error: "WALLET_ALREADY_LINKED" };
      this.ctx.storage.sql.exec("INSERT INTO wallets (wallet, profile_id, linked_at) VALUES (?, ?, ?)", wallet, id, now);
      this.ctx.storage.sql.exec("UPDATE profiles SET updated_at = ? WHERE id = ?", now, id);
      this.log(now, "wallet_linked", id, wallet, { by: ownerWallet });
      this.syncFomo(id, wallet, now);
      return { profile: this.view(this.profileRow(id)!, now) };
    });
  }

  /* Remove a wallet from the caller's profile; the last one stays. */
  unlinkWallet(ownerWallet: string, wallet: string, now: number): ProfileResult {
    return this.ctx.storage.transactionSync(() => {
      const id = this.profileIdForWallet(ownerWallet);
      if (id === null) return { error: "PROFILE_NOT_FOUND" };
      if (this.profileIdForWallet(wallet) !== id) return { error: "WALLET_NOT_LINKED" };
      if (this.walletsOf(id).length <= 1) return { error: "PROFILE_LAST_WALLET" };
      this.ctx.storage.sql.exec("DELETE FROM wallets WHERE wallet = ?", wallet);
      this.ctx.storage.sql.exec("UPDATE profiles SET updated_at = ? WHERE id = ?", now, id);
      this.log(now, "wallet_unlinked", id, wallet, { by: ownerWallet });
      this.syncFomo(id, wallet, now);
      return { profile: this.view(this.profileRow(id)!, now) };
    });
  }

  /* ---------- fomo detection (src/fomo.ts) */

  /* The chain check's answer for each of the wallets it has looked at. */
  fomoChecks(wallets: string[]): FomoCheckView[] {
    return this.fomoCheckRows(wallets).map((row) => this.fomoCheckView(row));
  }

  /* Record what the chain check found for a wallet, and bring its
     profile's fomo verification in line, if it has one. */
  recordFomoCheck(wallet: string, detection: FomoDetectionInput, now: number): FomoCheckView {
    return this.ctx.storage.transactionSync(() => {
      const before = this.fomoCheckRows([wallet])[0] ?? null;
      this.ctx.storage.sql.exec(
        `INSERT INTO fomo_checks (wallet, checked_at, detected, signature, scanned) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(wallet) DO UPDATE SET checked_at = excluded.checked_at, detected = excluded.detected,
           signature = excluded.signature, scanned = excluded.scanned`,
        wallet, now, detection.detected ? 1 : 0, detection.signature, detection.scanned,
      );
      const id = this.profileIdForWallet(wallet);
      if (detection.detected && (before === null || before.detected === 0)) {
        this.log(now, "fomo_wallet_detected", id, wallet, { signature: detection.signature, scanned: detection.scanned });
      }
      if (id !== null) this.syncFomo(id, wallet, now);
      return this.fomoCheckView(this.fomoCheckRows([wallet])[0]!);
    });
  }

  /* Make the profile's fee-payer verification match its wallets' checks:
     verified through its first detected linked wallet, or not at all. A
     verification by another method (a transfer, an official lookup) is
     not touched. */
  private syncFomo(profileId: string, by: string, now: number): void {
    const row = this.profileRow(profileId);
    if (row === null) return;
    if (row.fomo_verified_at !== null && row.fomo_method !== "fee_payer") return;
    const detected = this.fomoCheckRows(this.walletsOf(profileId).map(({ wallet }) => wallet))
      .filter((check) => check.detected === 1);
    const current = row.fomo_verified_at === null ? null : row.fomo_wallet;
    if (current !== null && detected.some((check) => check.wallet === current)) return;
    const next = detected[0] ?? null;
    if (next === null) {
      if (current === null) return;
      this.ctx.storage.sql.exec(
        "UPDATE profiles SET fomo_wallet = NULL, fomo_verified_at = NULL, fomo_method = NULL, updated_at = ? WHERE id = ?",
        now, profileId,
      );
      this.log(now, "fomo_unverified", profileId, by, { wallet: current });
      return;
    }
    this.ctx.storage.sql.exec(
      "UPDATE profiles SET fomo_wallet = ?, fomo_verified_at = ?, fomo_method = 'fee_payer', updated_at = ? WHERE id = ?",
      next.wallet, now, now, profileId,
    );
    this.log(now, "fomo_verified", profileId, by, { wallet: next.wallet, method: "fee_payer", signature: next.signature });
  }

  /* ---------- visibility */

  setVisibility(ownerWallet: string, show: Partial<ProfileVisibility>, now: number): ProfileResult {
    return this.ctx.storage.transactionSync(() => {
      const id = this.profileIdForWallet(ownerWallet);
      if (id === null) return { error: "PROFILE_NOT_FOUND" };
      const row = this.profileRow(id)!;
      const next = {
        wallets: show.wallets ?? row.show_wallets === 1,
        fomo: show.fomo ?? row.show_fomo === 1,
        x: show.x ?? row.show_x === 1,
      };
      this.ctx.storage.sql.exec(
        "UPDATE profiles SET show_wallets = ?, show_fomo = ?, show_x = ?, updated_at = ? WHERE id = ?",
        next.wallets ? 1 : 0, next.fomo ? 1 : 0, next.x ? 1 : 0, now, id,
      );
      this.log(now, "visibility_set", id, ownerWallet, next);
      return { profile: this.view(this.profileRow(id)!, now) };
    });
  }

  /* ---------- admin */

  adminLookup(by: { wallet?: string; username?: string; id?: string }, now: number): AdminProfileView {
    let id: string | null = null;
    if (by.id !== undefined) id = by.id;
    else if (by.wallet !== undefined) id = this.profileIdForWallet(by.wallet);
    else if (by.username !== undefined) {
      id = this.ctx.storage.sql
        .exec<UsernameRow>("SELECT * FROM usernames WHERE username_key = ?", by.username).toArray()[0]?.profile_id ?? null;
    }
    const row = id === null ? null : this.profileRow(id);
    const usernames = id === null ? [] : this.ctx.storage.sql.exec<UsernameRow>(
      "SELECT * FROM usernames WHERE profile_id = ? OR released_by = ? ORDER BY claimed_at", id, id,
    ).toArray().map((entry) => ({
      username: entry.username, profileId: entry.profile_id, claimedAt: entry.claimed_at, releasedAt: entry.released_at,
    }));
    const events = this.ctx.storage.sql.exec<{
      id: number; at: number; kind: string; profile_id: string | null; wallet: string | null; detail: string | null;
    }>(
      id === null && by.wallet !== undefined ?
        "SELECT * FROM events WHERE wallet = ? ORDER BY id DESC LIMIT ?" :
        "SELECT * FROM events WHERE profile_id = ? ORDER BY id DESC LIMIT ?",
      id ?? by.wallet ?? "", EVENTS_SHOWN,
    ).toArray().map((event) => ({
      id: event.id, at: event.at, kind: event.kind, profileId: event.profile_id, wallet: event.wallet, detail: event.detail,
    }));
    return { profile: row === null ? null : this.view(row, now), usernames, events };
  }
}
