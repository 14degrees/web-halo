import { DurableObject } from "cloudflare:workers";

/* The wager experiment's ledger: one singleton Durable Object holding each
   wallet's balance with the house, in lamports.

   Deposits are SOL players send the house wallet on chain; the Worker checks
   the transaction and credits it here, once per signature. Kills on a
   dedicated server move the wager from the victim's balance to the
   killer's. Withdrawals debit first and are refunded if the on-chain payout
   fails, so a balance never pays twice. */

export const BANK_NAME = "house";

export interface TransferResult {
  killerLamports: number;
  lamports: number;
  victimLamports: number;
}

export class Bank extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS balances (
        wallet TEXT PRIMARY KEY,
        lamports INTEGER NOT NULL CHECK (lamports >= 0)
      );
      CREATE TABLE IF NOT EXISTS deposits (
        signature TEXT PRIMARY KEY,
        wallet TEXT NOT NULL,
        lamports INTEGER NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ledger (
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        source TEXT,
        target TEXT,
        lamports INTEGER NOT NULL,
        reference TEXT
      );
    `);
  }

  private read(wallet: string): number {
    return (
      this.ctx.storage.sql
        .exec<{ lamports: number }>("SELECT lamports FROM balances WHERE wallet = ?", wallet)
        .toArray()[0]?.lamports ?? 0
    );
  }

  private write(wallet: string, lamports: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO balances (wallet, lamports) VALUES (?, ?)
       ON CONFLICT(wallet) DO UPDATE SET lamports = excluded.lamports`,
      wallet,
      lamports,
    );
  }

  async balance(wallet: string): Promise<number> {
    return this.read(wallet);
  }

  async balances(wallets: string[]): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    for (const wallet of wallets) result[wallet] = this.read(wallet);
    return result;
  }

  /* Credits a deposit once; a signature seen before credits nothing. */
  async creditDeposit(wallet: string, signature: string, lamports: number, now: number): Promise<{
    credited: boolean;
    lamports: number;
  }> {
    const seen = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM deposits WHERE signature = ?", signature)
      .one().count;
    if (seen > 0) return { credited: false, lamports: this.read(wallet) };
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO deposits (signature, wallet, lamports, at) VALUES (?, ?, ?, ?)",
        signature,
        wallet,
        lamports,
        now,
      );
      this.write(wallet, this.read(wallet) + lamports);
      this.ctx.storage.sql.exec(
        "INSERT INTO ledger (at, kind, source, target, lamports, reference) VALUES (?, 'deposit', NULL, ?, ?, ?)",
        now,
        wallet,
        lamports,
        signature,
      );
    });
    return { credited: true, lamports: this.read(wallet) };
  }

  /* A kill: up to `wager` lamports from the victim to the killer, never
     taking a balance below zero. */
  async transferForKill(
    victim: string,
    killer: string,
    wager: number,
    reference: string,
    now: number,
  ): Promise<TransferResult> {
    let moved = 0;
    this.ctx.storage.transactionSync(() => {
      const victimLamports = this.read(victim);
      moved = Math.min(wager, victimLamports);
      if (moved <= 0 || victim === killer) {
        moved = 0;
        return;
      }
      this.write(victim, victimLamports - moved);
      this.write(killer, this.read(killer) + moved);
      this.ctx.storage.sql.exec(
        "INSERT INTO ledger (at, kind, source, target, lamports, reference) VALUES (?, 'kill', ?, ?, ?, ?)",
        now,
        victim,
        killer,
        moved,
        reference,
      );
    });
    return { killerLamports: this.read(killer), lamports: moved, victimLamports: this.read(victim) };
  }

  /* Takes a withdrawal off the balance before it is paid; refund() puts it
     back if the payout fails. */
  async reserveWithdrawal(wallet: string, lamports: number, now: number): Promise<number | null> {
    let reserved: number | null = null;
    this.ctx.storage.transactionSync(() => {
      const balance = this.read(wallet);
      if (lamports <= 0 || lamports > balance) return;
      this.write(wallet, balance - lamports);
      this.ctx.storage.sql.exec(
        "INSERT INTO ledger (at, kind, source, target, lamports, reference) VALUES (?, 'withdraw', ?, NULL, ?, NULL)",
        now,
        wallet,
        lamports,
      );
      reserved = balance - lamports;
    });
    return reserved;
  }

  async refund(wallet: string, lamports: number, now: number): Promise<number> {
    this.ctx.storage.transactionSync(() => {
      this.write(wallet, this.read(wallet) + lamports);
      this.ctx.storage.sql.exec(
        "INSERT INTO ledger (at, kind, source, target, lamports, reference) VALUES (?, 'refund', NULL, ?, ?, NULL)",
        now,
        wallet,
        lamports,
      );
    });
    return this.read(wallet);
  }
}
