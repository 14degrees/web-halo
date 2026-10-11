/* Shows the escrow program's config and, with --send, changes its maximum
   stake through the operator's update_config. Every other setting is kept
   as it is on chain (update_config replaces them all at once).

     node .escrow-config.mjs <rpc-url> <keys-dir> [--maximum-stake <SOL>] [--send]

   <keys-dir> holds operator.json (a Solana CLI key file); only --send
   reads it. Without --send it prints the instruction and sends nothing.
   Built by `npm run escrow:config`. */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  assembleTransaction,
  compileMessage,
  configAddress,
  decodeConfig,
  type Instruction,
  updateConfigInstruction,
} from "../src/escrow";
import { keypairFromSecret, type Keypair, toBase64 } from "../src/solana";

const LAMPORTS_PER_SOL = 1_000_000_000;
const args = process.argv.slice(2);
const [rpcUrl, keysDir] = args;
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const send_ = args.includes("--send");
const wanted = flag("--maximum-stake");
if (!rpcUrl || !keysDir || rpcUrl.startsWith("--") || keysDir.startsWith("--")) {
  console.error("usage: node .escrow-config.mjs <rpc-url> <keys-dir> [--maximum-stake <SOL>] [--send]");
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

async function send(feePayer: Keypair, instructions: Instruction[]): Promise<string> {
  const { value } = await rpc<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
  const message = compileMessage(feePayer.address, instructions, value.blockhash);
  const signature = await rpc<string>("sendTransaction", [
    toBase64(assembleTransaction(message, new Map([[feePayer.address, await feePayer.sign(message.bytes)]]))),
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

async function readConfig() {
  const { value } = await rpc<{ value: { data: [string, string] } | null }>("getAccountInfo", [
    await configAddress(),
    { encoding: "base64", commitment: "confirmed" },
  ]);
  const config = value ? decodeConfig(Uint8Array.from(Buffer.from(value.data[0], "base64"))) : null;
  if (!config) throw new Error(`no escrow config at ${await configAddress()}`);
  return config;
}

const sol = (lamports: bigint) => `${Number(lamports) / LAMPORTS_PER_SOL} SOL`;

async function main(): Promise<void> {
  const config = await readConfig();
  console.log(`config ${await configAddress()}`);
  console.log(`  operator       ${config.operator}`);
  console.log(`  authority      ${config.authority}`);
  console.log(`  fee_vault      ${config.feeVault}`);
  console.log(`  fee_bps        ${config.feeBps}`);
  console.log(`  maximum_stake  ${config.maximumStake} (${sol(config.maximumStake)})`);
  console.log(`  reclaim_delay  ${config.reclaimDelaySeconds} s`);
  console.log(`  paused         ${config.paused}`);
  if (wanted === undefined) return;

  const maximumStake = BigInt(Math.round(Number(wanted) * LAMPORTS_PER_SOL));
  if (!(maximumStake > 0n)) throw new Error("--maximum-stake must be a positive amount of SOL");
  const settings = {
    authority: config.authority,
    feeVault: config.feeVault,
    feeBps: config.feeBps,
    maximumStake,
    reclaimDelaySeconds: config.reclaimDelaySeconds,
  };
  const instruction = await updateConfigInstruction(config.operator, settings);
  console.log(`update_config: maximum_stake ${sol(config.maximumStake)} -> ${sol(maximumStake)}, the rest unchanged`);
  console.log(`  data (base64) ${toBase64(instruction.data)}`);
  if (!send_) {
    console.log("not sent (pass --send to send it, signed by the operator)");
    return;
  }
  const operator = await keypairFromSecret(readFileSync(join(keysDir!, "operator.json"), "utf8"));
  if (operator.address !== config.operator) {
    throw new Error(`operator.json is ${operator.address}, but the config's operator is ${config.operator}`);
  }
  console.log(`sent: ${await send(operator, [instruction])}`);
  console.log(`maximum_stake is now ${sol((await readConfig()).maximumStake)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
