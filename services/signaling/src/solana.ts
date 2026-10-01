/* The little of Solana the wager experiment needs, without a client
   library: base58, Ed25519 signatures (Web Crypto), legacy System Program
   transfers, and the JSON-RPC calls to send and inspect them. */

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_MAP = new Map([...BASE58_ALPHABET].map((character, index) => [character, index]));

export const LAMPORTS_PER_SOL = 1_000_000_000;
/* The System Program's address is 32 zero bytes. */
const SYSTEM_PROGRAM = new Uint8Array(32);
const PKCS8_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  const digits: number[] = [];
  for (let index = zeros; index < bytes.length; index += 1) {
    let carry = bytes[index] ?? 0;
    for (let digit = 0; digit < digits.length; digit += 1) {
      carry += (digits[digit] ?? 0) << 8;
      digits[digit] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  return "1".repeat(zeros) + digits.reverse().map((digit) => BASE58_ALPHABET[digit]).join("");
}

export function base58Decode(text: string): Uint8Array | null {
  if (text.length === 0 || text.length > 128) return null;
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros += 1;
  const bytes: number[] = [];
  for (const character of text.slice(zeros)) {
    const value = BASE58_MAP.get(character);
    if (value === undefined) return null;
    let carry = value;
    for (let index = 0; index < bytes.length; index += 1) {
      carry += (bytes[index] ?? 0) * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes.reverse()]);
}

/* A wallet address: 32 bytes in base58. */
export function parseWallet(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) return null;
  const bytes = base58Decode(value);
  return bytes !== null && bytes.length === 32 ? value : null;
}

/* The in-game name a wallet plays under: unique enough, 10 characters, and
   within Halo's 11-character ASCII names (7xKX..gAsU). */
export function walletPlayerName(wallet: string): string {
  return `${wallet.slice(0, 4)}..${wallet.slice(-4)}`;
}

export async function verifyWalletSignature(
  wallet: string,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  const publicKey = base58Decode(wallet);
  if (publicKey === null || publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, signature, message);
  } catch {
    return false;
  }
}

/* A keypair as Solana tools print it: 64 bytes, seed then public key, in
   base58 (or as a JSON byte array). */
export interface Keypair {
  address: string;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

export async function keypairFromSecret(secret: string): Promise<Keypair> {
  let bytes: Uint8Array | null;
  const trimmed = secret.trim();
  if (trimmed.startsWith("[")) {
    bytes = Uint8Array.from(JSON.parse(trimmed) as number[]);
  } else {
    bytes = base58Decode(trimmed);
  }
  if (bytes === null || bytes.length !== 64) {
    throw new Error("The house key must be a 64-byte Solana secret key.");
  }
  const seed = bytes.slice(0, 32);
  const address = base58Encode(bytes.slice(32));
  const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
  pkcs8.set(PKCS8_ED25519_PREFIX);
  pkcs8.set(seed, PKCS8_ED25519_PREFIX.length);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  return {
    address,
    async sign(message: Uint8Array): Promise<Uint8Array> {
      return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, message));
    },
  };
}

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

/* The message of a legacy transaction moving lamports from one account to
   another with the System Program, the sender paying the fee. */
export function transferMessage(
  from: string,
  to: string,
  lamports: number,
  recentBlockhash: string,
): Uint8Array {
  const fromKey = base58Decode(from);
  const toKey = base58Decode(to);
  const blockhash = base58Decode(recentBlockhash);
  if (fromKey?.length !== 32 || toKey?.length !== 32 || blockhash?.length !== 32) {
    throw new Error("A transfer needs two addresses and a blockhash.");
  }
  if (!Number.isSafeInteger(lamports) || lamports <= 0) {
    throw new Error("A transfer needs a positive whole number of lamports.");
  }
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, BigInt(lamports), true);
  return Uint8Array.from([
    /* header: one signer (writable), no read-only signers, one read-only
       unsigned account (the System Program) */
    1, 0, 1,
    ...compactLength(3), ...fromKey, ...toKey, ...SYSTEM_PROGRAM,
    ...blockhash,
    ...compactLength(1),
    2, ...compactLength(2), 0, 1,
    ...compactLength(data.length), ...data,
  ]);
}

export function transactionBytes(message: Uint8Array, signature?: Uint8Array): Uint8Array {
  return Uint8Array.from([...compactLength(1), ...(signature ?? new Uint8Array(64)), ...message]);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/* Some public RPC endpoints refuse requests from cloud networks (Solana's
   own devnet endpoint answers Cloudflare with 403), so the Worker takes a
   comma-separated list and moves to the next endpoint when one refuses or
   cannot be reached. An answer that is an RPC error is final. */
/* The network answered and refused: a transaction that failed its checks
   (a program error), not a network that could not be reached. */
export class SolanaRpcError extends Error {}

export class SolanaRpc {
  private readonly urls: string[];

  constructor(urls: string) {
    this.urls = urls.split(",").map((url) => url.trim()).filter((url) => url.length > 0);
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    let failure = "no RPC endpoint is configured";
    for (const url of this.urls) {
      let response: Response;
      try {
        response = await fetch(url, {
          body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
          headers: { "Content-Type": "application/json", "User-Agent": "halo-web-signaling/1" },
          method: "POST",
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        failure = `${new URL(url).host} unreachable (${error instanceof Error ? error.message : String(error)})`;
        continue;
      }
      if (!response.ok) {
        failure = `${new URL(url).host} answered ${response.status}`;
        continue;
      }
      const body = await response.json<{ error?: { message?: string }; result?: T }>();
      if (body.error) throw new SolanaRpcError(`Solana RPC ${method}: ${body.error.message ?? "error"}`);
      return body.result as T;
    }
    throw new Error(`Solana RPC ${method} failed: ${failure}.`);
  }

  async latestBlockhash(): Promise<string> {
    const result = await this.call<{ value: { blockhash: string } }>("getLatestBlockhash", [
      { commitment: "confirmed" },
    ]);
    return result.value.blockhash;
  }

  async balance(address: string): Promise<number> {
    const result = await this.call<{ value: number }>("getBalance", [address, { commitment: "confirmed" }]);
    return result.value;
  }

  /* An account's data, or null if it does not exist. */
  async accountData(address: string): Promise<Uint8Array | null> {
    const result = await this.call<{ value: { data: [string, string] } | null }>("getAccountInfo", [
      address,
      { commitment: "confirmed", encoding: "base64" },
    ]);
    if (!result.value) return null;
    const binary = atob(result.value.data[0]);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  /* A transaction's fate: "confirmed", "failed", or "unknown" (not seen, or
     not yet confirmed). */
  async signatureStatus(signature: string): Promise<"confirmed" | "failed" | "unknown"> {
    const result = await this.call<{ value: Array<{ confirmationStatus?: string; err: unknown } | null> }>(
      "getSignatureStatuses",
      [[signature], { searchTransactionHistory: true }],
    );
    const status = result.value[0];
    if (!status) return "unknown";
    if (status.err) return "failed";
    return status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized" ?
      "confirmed" : "unknown";
  }

  async sendTransaction(bytes: Uint8Array): Promise<string> {
    return this.call<string>("sendTransaction", [
      toBase64(bytes),
      { encoding: "base64", preflightCommitment: "confirmed" },
    ]);
  }

  /* How many lamports a confirmed transaction moved from `from` to `to`, or
     null if it failed, is unknown, or did not move any. */
  async transferredLamports(signature: string, from: string, to: string): Promise<number | null> {
    const result = await this.call<{
      meta: { err: unknown; postBalances: number[]; preBalances: number[] } | null;
      transaction: { message: { accountKeys: string[] } };
    } | null>("getTransaction", [
      signature,
      { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 0 },
    ]);
    if (!result || !result.meta || result.meta.err !== null) return null;
    const keys = result.transaction.message.accountKeys;
    if (keys[0] !== from) return null;
    const index = keys.indexOf(to);
    if (index < 0) return null;
    const received = (result.meta.postBalances[index] ?? 0) - (result.meta.preBalances[index] ?? 0);
    return received > 0 ? received : null;
  }
}
