/* Sets up the escrow program on a cluster and plays one wagered match on it
   with two throwaway players, through the same client the Worker uses
   (src/escrow.ts).

     node scripts/escrow-devnet.mjs <rpc-url> <keys-dir>

   <keys-dir> holds deployer.json, operator.json and authority.json (Solana
   CLI key files). Built by `npm run escrow:devnet`. */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ed25519 } from "@noble/curves/ed25519.js";

import {
  assembleTransaction,
  closeMatchInstruction,
  compileMessage,
  configAddress,
  createMatchInstruction,
  decodeMatch,
  decodeVault,
  depositInstruction,
  escrowMatchId,
  initializeInstruction,
  type Instruction,
  joinMatchInstruction,
  matchAddress,
  openSessionInstruction,
  openVaultInstruction,
  settleInstruction,
  vaultAddress,
} from "../src/escrow";
import { base58Encode, keypairFromSecret, type Keypair, toBase64 } from "../src/solana";

const SOL = 1_000_000_000n;
const [rpcUrl, keysDir] = process.argv.slice(2);
if (!rpcUrl || !keysDir) {
  console.error("usage: node scripts/escrow-devnet.mjs <rpc-url> <keys-dir>");
  process.exit(2);
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(rpcUrl!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
  });
  const body = (await response.json()) as { error?: { message: string; data?: { logs?: string[] } }; result: T };
  if (body.error) {
    const logs = body.error.data?.logs?.filter((line) => line.includes("Error") || line.includes("failed")) ?? [];
    throw new Error(`${method}: ${body.error.message}${logs.length ? `\n  ${logs.join("\n  ")}` : ""}`);
  }
  return body.result;
}

async function send(feePayer: Keypair, instructions: Instruction[], signers: Keypair[]): Promise<string> {
  const { value } = await rpc<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
  const message = compileMessage(feePayer.address, instructions, value.blockhash);
  const signatures = new Map<string, Uint8Array>();
  for (const signer of [feePayer, ...signers]) signatures.set(signer.address, await signer.sign(message.bytes));
  const signature = await rpc<string>("sendTransaction", [
    toBase64(assembleTransaction(message, signatures)),
    { encoding: "base64", preflightCommitment: "confirmed" },
  ]);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const { value: statuses } = await rpc<{ value: Array<{ confirmationStatus?: string; err: unknown } | null> }>(
      "getSignatureStatuses",
      [[signature]],
    );
    const status = statuses[0];
    if (status?.err) throw new Error(`${signature} failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return signature;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${signature} was not confirmed`);
}

async function account(address: string): Promise<Uint8Array | null> {
  const { value } = await rpc<{ value: { data: [string, string] } | null }>("getAccountInfo", [
    address,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  return value ? Uint8Array.from(Buffer.from(value.data[0], "base64")) : null;
}

async function loadKey(name: string): Promise<Keypair> {
  return keypairFromSecret(readFileSync(join(keysDir!, `${name}.json`), "utf8"));
}

async function freshKey(): Promise<Keypair> {
  const seed = ed25519.utils.randomSecretKey();
  const secret = new Uint8Array(64);
  secret.set(seed);
  secret.set(ed25519.getPublicKey(seed), 32);
  return keypairFromSecret(base58Encode(secret));
}

function systemTransfer(from: string, to: string, lamports: bigint): Instruction {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, lamports, true);
  return {
    programId: "11111111111111111111111111111111",
    keys: [
      { pubkey: from, isSigner: true, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
    ],
    data,
  };
}

const sol = (lamports: bigint) => `${Number(lamports) / 1e9} SOL`;

async function main(): Promise<void> {
  const deployer = await loadKey("deployer");
  const operator = await loadKey("operator");
  const authority = await loadKey("authority");

  if (await account(await configAddress())) {
    console.log("config: already set up");
  } else {
    const signature = await send(operator, [
      await initializeInstruction(operator.address, {
        authority: authority.address,
        feeVault: operator.address,
        feeBps: 500,
        maximumStake: SOL / 10n,
        reclaimDelaySeconds: 24 * 60 * 60,
      }),
    ], []);
    console.log(`config: set up (${signature})`);
  }

  /* two players: a wallet, a vault with 0.02 SOL, a session key allowed 0.02 */
  const players: Array<{ wallet: Keypair; session: Keypair }> = [];
  for (let index = 0; index < 2; index += 1) {
    const wallet = await freshKey();
    const session = await freshKey();
    await send(deployer, [systemTransfer(deployer.address, wallet.address, SOL / 20n)], []);
    const expiry = Math.floor(Date.now() / 1000) + 60 * 60;
    const signature = await send(wallet, [
      await openVaultInstruction(wallet.address),
      await depositInstruction(wallet.address, SOL / 50n),
      await openSessionInstruction(wallet.address, session.address, SOL / 50n, expiry),
    ], []);
    console.log(`player ${index + 1} ${wallet.address}: vault opened, 0.02 SOL in, session approved (${signature})`);
    players.push({ wallet, session });
  }

  const matchId = await escrowMatchId(`devnet-smoke-${Date.now()}`);
  const stake = SOL / 100n;
  console.log(`match ${await matchAddress(matchId)}`);
  console.log(`  created: ${await send(authority, [await createMatchInstruction(authority.address, matchId, stake, 2)], [])}`);
  for (const [index, player] of players.entries()) {
    const signature = await send(
      authority,
      [await joinMatchInstruction(authority.address, matchId, player.wallet.address, player.session.address)],
      [player.session],
    );
    console.log(`  player ${index + 1} joined: ${signature}`);
  }
  const live = decodeMatch((await account(await matchAddress(matchId)))!);
  console.log(`  on chain: ${live?.state}, ${live?.players.length} players, stake ${sol(live!.stake)}`);

  const pot = stake * 2n;
  const fee = (pot * 5n) / 100n;
  const owners = players.map((player) => player.wallet.address);
  const resultHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("player 1 wins")));
  const feeBefore = BigInt(
    (await rpc<{ value: number }>("getBalance", [operator.address, { commitment: "confirmed" }])).value,
  );
  console.log(`  settled: ${await send(authority, [
    await settleInstruction(authority.address, matchId, owners, [pot - fee, 0n], resultHash, operator.address),
  ], [])}`);
  console.log(`  closed: ${await send(authority, [await closeMatchInstruction(authority.address, matchId)], [])}`);
  const feeAfter = BigInt(
    (await rpc<{ value: number }>("getBalance", [operator.address, { commitment: "confirmed" }])).value,
  );

  for (const [index, owner] of owners.entries()) {
    const vault = decodeVault((await account(await vaultAddress(owner)))!);
    console.log(`player ${index + 1} vault: free ${sol(vault!.free)}, locked ${sol(vault!.locked)}`);
  }
  console.log(`fee vault received ${sol(feeAfter - feeBefore)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
