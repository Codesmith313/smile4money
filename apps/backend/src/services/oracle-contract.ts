import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { OracleSubmission } from "./oracle-submit.js";

/** Distinct, non-retryable contract rejection reasons surfaced to the retry/DLQ layer. */
export type OracleContractErrorCode =
  | "Unauthorized"
  | "ReplayDetected"
  | "InvalidTimestamp"
  | "MatchAlreadyCompleted";

export class OracleContractError extends Error {
  constructor(
    public readonly code: OracleContractErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OracleContractError";
  }
}

/** A transport accepts the already authorized signer for this attempt only. */
export class OracleContractTransport {
  constructor(
    private server: rpc.Server,
    private contractId: string,
    private networkPassphrase: string,
    private wait = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
    private registeredOracle?: string,
  ) {}

  async hasResult(matchId: number): Promise<boolean> {
    // Read-only simulation needs no funded source account and no private key.
    const source = new Account(Keypair.random().publicKey(), "0");
    const transaction = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        new Contract(this.contractId).call(
          "has_result",
          nativeToScVal(BigInt(matchId), { type: "u64" }),
        ),
      )
      .setTimeout(30)
      .build();
    const simulation = await this.server.simulateTransaction(transaction);
    if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
      throw new Error("Oracle result lookup failed");
    }
    const exists = scValToNative(simulation.result.retval);
    if (typeof exists !== "boolean")
      throw new Error("Oracle result lookup returned an invalid value");
    return exists;
  }

  async submit(submission: OracleSubmission, signer: Keypair): Promise<void> {
    if (
      !Number.isSafeInteger(submission.matchId) ||
      submission.matchId <= 0 ||
      !["Player1Wins", "Player2Wins", "Draw"].includes(submission.result) ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(submission.gameId)
    ) {
      throw new Error("Invalid oracle submission");
    }
    if (
      !Number.isSafeInteger(submission.nonce) ||
      submission.nonce < 0 ||
      !Number.isSafeInteger(submission.timestamp) ||
      submission.timestamp <= 0
    ) {
      throw new Error("Invalid oracle submission");
    }
    // Fail fast: only the registered oracle may submit results.
    if (
      this.registeredOracle !== undefined &&
      signer.publicKey() !== this.registeredOracle
    ) {
      throw new OracleContractError(
        "Unauthorized",
        "Signer is not the registered oracle",
      );
    }
    const source = await this.server.getAccount(signer.publicKey());
    const transaction = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        new Contract(this.contractId).call(
          "submit_result",
          nativeToScVal(BigInt(submission.matchId), { type: "u64" }),
          nativeToScVal(submission.gameId, { type: "string" }),
          xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(submission.result)]),
          nativeToScVal(BigInt(submission.nonce), { type: "u64" }),
          nativeToScVal(BigInt(submission.timestamp), { type: "u64" }),
        ),
      )
      .setTimeout(60)
      .build();
    const prepared = await this.server.prepareTransaction(transaction);
    prepared.sign(signer);
    const sent = await this.server.sendTransaction(prepared);
    if (!["PENDING", "DUPLICATE"].includes(sent.status))
      throw new Error("Oracle RPC rejected submission");
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = await this.server.getTransaction(sent.hash);
      if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) return;
      if (result.status === rpc.Api.GetTransactionStatus.FAILED)
        throw classifyContractFailure(result);
      await this.wait(1000);
    }
    throw new Error("Oracle transaction confirmation pending");
  }
}

/** Map a failed transaction's result codes to a distinct, non-retryable error. */
function classifyContractFailure(
  result: rpc.Api.GetFailedTransactionResponse,
): Error {
  const codes = extractContractErrorCodes(result);
  if (codes.includes("ReplayDetected"))
    return new OracleContractError(
      "ReplayDetected",
      "Oracle result replay detected",
    );
  if (codes.includes("InvalidTimestamp"))
    return new OracleContractError(
      "InvalidTimestamp",
      "Oracle result timestamp is invalid",
    );
  if (codes.includes("MatchAlreadyCompleted"))
    return new OracleContractError(
      "MatchAlreadyCompleted",
      "Match already completed; result cannot be overridden",
    );
  if (codes.includes("Unauthorized"))
    return new OracleContractError(
      "Unauthorized",
      "Oracle submission is not authorized",
    );
  return new Error("Oracle transaction failed");
}

/** Best-effort extraction of contract error symbol names from a failed tx. */
function extractContractErrorCodes(
  result: rpc.Api.GetFailedTransactionResponse,
): string[] {
  const codes: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") {
      codes.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) collect(item);
    } else if (value && typeof value === "object") {
      for (const item of Object.values(value)) collect(item);
    }
  };
  try {
    const meta = (result as { resultMetaXdr?: unknown }).resultMetaXdr;
    if (meta !== undefined) collect(scValToNative(meta as xdr.ScVal));
  } catch {
    // Ignore decoding failures; fall back to the generic error.
  }
  return codes;
}

export function oracleNetworkPassphrase(env = process.env): string {
  if (env.STELLAR_NETWORK_PASSPHRASE) return env.STELLAR_NETWORK_PASSPHRASE;
  switch (env.STELLAR_NETWORK ?? "testnet") {
    case "testnet":
      return Networks.TESTNET;
    case "mainnet":
      return Networks.PUBLIC;
    default:
      throw new Error(
        "Set STELLAR_NETWORK_PASSPHRASE for a custom Stellar network",
      );
  }
}
