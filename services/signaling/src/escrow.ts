import { ed25519 } from "@noble/curves/ed25519.js";

import { base58Decode, base58Encode } from "./solana";

/* A client for the escrow program (services/escrow): its addresses, its
   instructions in Anchor's encoding, and legacy transactions holding them.
   No Solana library: the Worker builds and signs these itself. */

export const ESCROW_PROGRAM_ID = "3dPU7bDe3Bqfzx7z2g4hVr9cNQGeZqR1oHCkti5uD3bJ";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

/* Anchor's instruction discriminators: the first 8 bytes of
   sha256("global:<name>"), from the program's interface file
   (services/escrow/target/idl/halo_escrow.json). */
const DISCRIMINATORS = {
  close_match: [79, 174, 36, 80, 233, 185, 176, 239],
  create_match: [107, 2, 184, 145, 70, 142, 17, 165],
  deposit: [242, 35, 198, 137, 82, 225, 242, 182],
  initialize: [175, 175, 109, 31, 13, 152, 155, 237],
  join_match: [244, 8, 47, 130, 192, 59, 179, 44],
  open_session: [130, 54, 124, 7, 236, 20, 104, 104],
  open_vault: [181, 248, 228, 67, 6, 175, 37, 167],
  settle: [175, 42, 185, 87, 144, 131, 102, 212],
  set_paused: [91, 60, 125, 192, 176, 225, 166, 218],
  void_match: [108, 111, 216, 72, 110, 46, 217, 140],
  withdraw: [183, 18, 70, 156, 148, 109, 161, 34],
} as const;

/* account discriminators, to read accounts */
const VAULT_DISCRIMINATOR = [211, 8, 232, 43, 2, 152, 117, 119];
const MATCH_DISCRIMINATOR = [236, 63, 169, 38, 15, 56, 196, 162];

export interface AccountMeta {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface Instruction {
  programId: string;
  keys: AccountMeta[];
  data: Uint8Array;
}

function key(address: string): Uint8Array {
  const bytes = base58Decode(address);
  if (!bytes || bytes.length !== 32) throw new Error(`Not a Solana address: ${address}`);
  return bytes;
}

/* ---------- encoding (Borsh, little-endian) */

class Writer {
  private bytes: number[] = [];

  raw(values: ArrayLike<number>): this {
    for (let index = 0; index < values.length; index += 1) this.bytes.push(values[index]!);
    return this;
  }
  u8(value: number): this {
    return this.raw([value & 0xff]);
  }
  u16(value: number): this {
    return this.raw([value & 0xff, (value >> 8) & 0xff]);
  }
  u32(value: number): this {
    const data = new Uint8Array(4);
    new DataView(data.buffer).setUint32(0, value, true);
    return this.raw(data);
  }
  u64(value: bigint | number): this {
    const data = new Uint8Array(8);
    new DataView(data.buffer).setBigUint64(0, BigInt(value), true);
    return this.raw(data);
  }
  i64(value: bigint | number): this {
    const data = new Uint8Array(8);
    new DataView(data.buffer).setBigInt64(0, BigInt(value), true);
    return this.raw(data);
  }
  pubkey(address: string): this {
    return this.raw(key(address));
  }
  done(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

function instructionData(name: keyof typeof DISCRIMINATORS): Writer {
  return new Writer().raw(DISCRIMINATORS[name]);
}

/* ---------- program addresses */

function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

/* Solana's find_program_address: the first bump from 255 down whose
   sha256(seeds, bump, program, "ProgramDerivedAddress") is off the curve. */
export async function findProgramAddress(seeds: Uint8Array[], programId: string): Promise<[string, number]> {
  const program = key(programId);
  const marker = new TextEncoder().encode("ProgramDerivedAddress");
  for (let bump = 255; bump >= 0; bump -= 1) {
    const input = new Writer();
    for (const seed of seeds) input.raw(seed);
    input.u8(bump).raw(program).raw(marker);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", input.done()));
    if (!isOnCurve(hash)) return [base58Encode(hash), bump];
  }
  throw new Error("No program address for these seeds.");
}

const encoder = new TextEncoder();

export async function configAddress(): Promise<string> {
  return (await findProgramAddress([encoder.encode("config")], ESCROW_PROGRAM_ID))[0];
}

export async function vaultAddress(owner: string): Promise<string> {
  return (await findProgramAddress([encoder.encode("vault"), key(owner)], ESCROW_PROGRAM_ID))[0];
}

export async function matchAddress(matchId: Uint8Array): Promise<string> {
  return (await findProgramAddress([encoder.encode("match"), matchId], ESCROW_PROGRAM_ID))[0];
}

/* A 16-byte on-chain match ID from the matchmaker's match ID. */
export async function escrowMatchId(matchId: string): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(`halo-match:${matchId}`));
  return new Uint8Array(hash).slice(0, 16);
}

/* ---------- instructions */

const writable = (pubkey: string, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const readonly = (pubkey: string, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });

export interface EscrowSettings {
  authority: string;
  feeVault: string;
  feeBps: number;
  maximumStake: bigint;
  reclaimDelaySeconds: number;
}

export async function initializeInstruction(operator: string, settings: EscrowSettings): Promise<Instruction> {
  return {
    programId: ESCROW_PROGRAM_ID,
    keys: [writable(await configAddress()), writable(operator, true), readonly(SYSTEM_PROGRAM_ID)],
    data: instructionData("initialize")
      .pubkey(settings.authority)
      .pubkey(settings.feeVault)
      .u16(settings.feeBps)
      .u64(settings.maximumStake)
      .i64(settings.reclaimDelaySeconds)
      .done(),
  };
}

export async function openVaultInstruction(owner: string): Promise<Instruction> {
  return {
    programId: ESCROW_PROGRAM_ID,
    keys: [writable(await vaultAddress(owner)), writable(owner, true), readonly(SYSTEM_PROGRAM_ID)],
    data: instructionData("open_vault").done(),
  };
}

export async function depositInstruction(owner: string, lamports: bigint): Promise<Instruction> {
  return {
    programId: ESCROW_PROGRAM_ID,
    keys: [writable(await vaultAddress(owner)), writable(owner, true), readonly(SYSTEM_PROGRAM_ID)],
    data: instructionData("deposit").u64(lamports).done(),
  };
}

export async function withdrawInstruction(owner: string, lamports: bigint): Promise<Instruction> {
  return {
    programId: ESCROW_PROGRAM_ID,
    keys: [writable(await vaultAddress(owner)), writable(owner, true)],
    data: instructionData("withdraw").u64(lamports).done(),
  };
}

export async function openSessionInstruction(
  owner: string,
  sessionKey: string,
  limit: bigint,
  expiry: number,
): Promise<Instruction> {
  return {
    programId: ESCROW_PROGRAM_ID,
    keys: [writable(await vaultAddress(owner)), readonly(owner, true)],
    data: instructionData("open_session").pubkey(sessionKey).u64(limit).i64(expiry).done(),
  };
}

export async function createMatchInstruction(
  authority: string,
  matchId: Uint8Array,
  stake: bigint,
  capacity: number,
): Promise<Instruction> {
  return {
    programId: ESCROW_PROGRAM_ID,
    keys: [
      readonly(await configAddress()),
      writable(await matchAddress(matchId)),
      writable(authority, true),
      readonly(SYSTEM_PROGRAM_ID),
    ],
    data: instructionData("create_match").raw(matchId).u64(stake).u8(capacity).done(),
  };
}

export async function joinMatchInstruction(
  authority: string,
  matchId: Uint8Array,
  owner: string,
  sessionKey: string,
): Promise<Instruction> {
  return {
    programId: ESCROW_PROGRAM_ID,
    keys: [
      readonly(await configAddress()),
      writable(await matchAddress(matchId)),
      writable(await vaultAddress(owner)),
      readonly(sessionKey, true),
      readonly(authority, true),
    ],
    data: instructionData("join_match").done(),
  };
}

async function settleKeys(authority: string, matchId: Uint8Array, owners: string[]): Promise<AccountMeta[]> {
  const keys = [readonly(await configAddress()), writable(await matchAddress(matchId)), readonly(authority, true)];
  for (const owner of owners) keys.push(writable(await vaultAddress(owner)));
  return keys;
}

/* The owners in the order they joined; the payouts in the same order. */
export async function settleInstruction(
  authority: string,
  matchId: Uint8Array,
  owners: string[],
  payouts: bigint[],
  resultHash: Uint8Array,
  feeVault: string,
): Promise<Instruction> {
  const data = instructionData("settle").u32(payouts.length);
  for (const payout of payouts) data.u64(payout);
  data.raw(resultHash);
  return {
    programId: ESCROW_PROGRAM_ID,
    keys: [...(await settleKeys(authority, matchId, owners)), writable(feeVault)],
    data: data.done(),
  };
}

export async function voidMatchInstruction(authority: string, matchId: Uint8Array, owners: string[]): Promise<Instruction> {
  return {
    programId: ESCROW_PROGRAM_ID,
    keys: await settleKeys(authority, matchId, owners),
    data: instructionData("void_match").done(),
  };
}

export async function closeMatchInstruction(authority: string, matchId: Uint8Array): Promise<Instruction> {
  return {
    programId: ESCROW_PROGRAM_ID,
    keys: [readonly(await configAddress()), writable(await matchAddress(matchId)), writable(authority, true)],
    data: instructionData("close_match").done(),
  };
}

/* ---------- accounts */

export interface VaultState {
  owner: string;
  free: bigint;
  locked: bigint;
  sessionKey: string;
  sessionLimit: bigint;
  sessionSpent: bigint;
  sessionExpiry: number;
  holdUntil: number;
}

function startsWith(data: Uint8Array, prefix: number[]): boolean {
  return prefix.every((byte, index) => data[index] === byte);
}

export function decodeVault(data: Uint8Array): VaultState | null {
  if (data.length < 8 + 32 + 8 * 2 + 32 + 8 * 4 || !startsWith(data, VAULT_DISCRIMINATOR)) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    owner: base58Encode(data.slice(8, 40)),
    free: view.getBigUint64(40, true),
    locked: view.getBigUint64(48, true),
    sessionKey: base58Encode(data.slice(56, 88)),
    sessionLimit: view.getBigUint64(88, true),
    sessionSpent: view.getBigUint64(96, true),
    sessionExpiry: Number(view.getBigInt64(104, true)),
    holdUntil: Number(view.getBigInt64(112, true)),
  };
}

export interface MatchAccountState {
  stake: bigint;
  capacity: number;
  state: "open" | "settled" | "void";
  players: string[];
}

export function decodeMatch(data: Uint8Array): MatchAccountState | null {
  if (data.length < 8 + 16 + 8 + 2 + 4 || !startsWith(data, MATCH_DISCRIMINATOR)) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const stake = view.getBigUint64(24, true);
  const capacity = data[32]!;
  const state = (["open", "settled", "void"] as const)[data[33]!] ?? "open";
  const count = view.getUint32(34, true);
  const players: string[] = [];
  for (let index = 0; index < count && index < 8; index += 1) {
    players.push(base58Encode(data.slice(38 + index * 32, 70 + index * 32)));
  }
  return { stake, capacity, state, players };
}

/* ---------- legacy transactions */

function compactLength(length: number): number[] {
  const out: number[] = [];
  let remaining = length;
  for (;;) {
    let byte = remaining & 0x7f;
    remaining >>= 7;
    if (remaining === 0) {
      out.push(byte);
      return out;
    }
    byte |= 0x80;
    out.push(byte);
  }
}

export interface CompiledMessage {
  bytes: Uint8Array;
  /* the signers, in the order their signatures go */
  signers: string[];
}

/* A legacy message: the fee payer first, then signers that write, signers
   that only read, accounts that write, accounts that only read. */
export function compileMessage(feePayer: string, instructions: Instruction[], recentBlockhash: string): CompiledMessage {
  const accounts = new Map<string, { isSigner: boolean; isWritable: boolean }>();
  accounts.set(feePayer, { isSigner: true, isWritable: true });
  for (const instruction of instructions) {
    for (const meta of instruction.keys) {
      const known = accounts.get(meta.pubkey);
      accounts.set(meta.pubkey, {
        isSigner: (known?.isSigner ?? false) || meta.isSigner,
        isWritable: (known?.isWritable ?? false) || meta.isWritable,
      });
    }
    if (!accounts.has(instruction.programId)) accounts.set(instruction.programId, { isSigner: false, isWritable: false });
  }
  const entries = [...accounts.entries()];
  const rank = ([pubkey, flags]: [string, { isSigner: boolean; isWritable: boolean }]) =>
    pubkey === feePayer ? 0 : flags.isSigner ? (flags.isWritable ? 1 : 2) : flags.isWritable ? 3 : 4;
  entries.sort((left, right) => rank(left) - rank(right));
  const order = entries.map(([pubkey]) => pubkey);
  const signers = entries.filter(([, flags]) => flags.isSigner).map(([pubkey]) => pubkey);
  const readonlySigners = entries.filter(([, flags]) => flags.isSigner && !flags.isWritable).length;
  const readonlyUnsigned = entries.filter(([, flags]) => !flags.isSigner && !flags.isWritable).length;
  const blockhash = key(recentBlockhash);

  const out = new Writer().u8(signers.length).u8(readonlySigners).u8(readonlyUnsigned);
  out.raw(compactLength(order.length));
  for (const pubkey of order) out.pubkey(pubkey);
  out.raw(blockhash);
  out.raw(compactLength(instructions.length));
  for (const instruction of instructions) {
    out.u8(order.indexOf(instruction.programId));
    out.raw(compactLength(instruction.keys.length));
    for (const meta of instruction.keys) out.u8(order.indexOf(meta.pubkey));
    out.raw(compactLength(instruction.data.length));
    out.raw(instruction.data);
  }
  return { bytes: out.done(), signers };
}

/* The wire transaction: each signer's signature (zeros where missing), then
   the message. */
export function assembleTransaction(message: CompiledMessage, signatures: Map<string, Uint8Array>): Uint8Array {
  const out = new Writer().raw(compactLength(message.signers.length));
  for (const signer of message.signers) out.raw(signatures.get(signer) ?? new Uint8Array(64));
  return out.raw(message.bytes).done();
}
