/**
 * Backend binding to the deployed contracts' interface (#120).
 *
 * Generated fixture: contracts/interface/contract-interface.json, produced by
 * `node scripts/generate-contract-interface.mjs` from the contract sources.
 * The frontend (`apps/frontend/src/contract/contract-interface.ts`) has an equivalent module, and both are tested against
 * that one fixture, so the two clients cannot drift apart or away from the
 * contract without a failing test.
 *
 * When the fixture changes, review every method and error below against it,
 * then set {@link CONTRACT_INTERFACE_SPEC_HASH} to the new `specHash`.
 */
import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import type { MatchResult } from '../fetchers/lichess.js';

/** `specHash` of the fixture this module was last reviewed against. */
export const CONTRACT_INTERFACE_SPEC_HASH = '7c1e9a4b2f8d3e05';

/**
 * Escrow contract error codes (`contracts/escrow/src/errors.rs`). Must match
 * the shared fixture exactly; see the module comment.
 *
 * Note: the contract currently assigns code 28 to both TokenNotAllowlisted
 * and DisputeWindowExpired. The table mirrors the contract as written;
 * {@link escrowErrorName} reports the first name for a shared code.
 */
export const ESCROW_ERRORS = {
  MatchNotFound: 1,
  AlreadyFunded: 2,
  NotFunded: 3,
  Unauthorized: 4,
  InvalidState: 5,
  AlreadyExists: 6,
  AlreadyInitialized: 7,
  Overflow: 8,
  ContractPaused: 9,
  InvalidAmount: 10,
  InvalidGameId: 11,
  InvalidPlayers: 12,
  GameIdMismatch: 13,
  DuplicateGameId: 14,
  TransferFailed: 15,
  MatchCancelled: 16,
  MatchCompleted: 17,
  NotPaused: 18,
  InsufficientAllowance: 19,
  DisputeWindowActive: 20,
  MatchTimedOut: 21,
  InvalidToken: 22,
  InvalidAdmin: 23,
  StakeTooLow: 24,
  StakeTooHigh: 25,
  InsufficientReserve: 26,
  InvalidAddress: 27,
  TokenNotAllowlisted: 28,
  TokenAlreadyListed: 29,
  TokenNotListed: 30,
  CannotRemoveDefault: 31,
  InvalidStakeAmount: 32,
  ActiveMatchExists: 33,
  DisputeWindowExpired: 28,
  TokenWhitelistEmpty: 34,
  TokenAlreadyWhitelisted: 35,
  TokenNotWhitelisted: 36,
  CannotRemoveDefaultToken: 37,
  TokenBalanceOverflow: 38,
  UnknownToken: 39,
} as const;

/** Leaderboard contract error codes (`contracts/leaderboard/src/types.rs`). */
export const LEADERBOARD_ERRORS = {
  AlreadyInitialized: 1,
  Unauthorized: 2,
  NotInitialized: 3,
  InvalidResult: 4,
  InvalidRange: 5,
  ContractPaused: 6,
} as const;

export type EscrowErrorName = keyof typeof ESCROW_ERRORS;
export type LeaderboardErrorName = keyof typeof LEADERBOARD_ERRORS;

function nameByCode<T extends Record<string, number>>(errors: T): Map<number, keyof T & string> {
  const names = new Map<number, keyof T & string>();
  for (const [name, code] of Object.entries(errors)) {
    if (!names.has(code)) names.set(code, name as keyof T & string);
  }
  return names;
}

const ESCROW_ERROR_NAMES = nameByCode(ESCROW_ERRORS);
const LEADERBOARD_ERROR_NAMES = nameByCode(LEADERBOARD_ERRORS);

/** Name of an escrow contract error code, or undefined for an unknown code. */
export function escrowErrorName(code: number): EscrowErrorName | undefined {
  return ESCROW_ERROR_NAMES.get(code);
}

/** Name of a leaderboard contract error code, or undefined for an unknown code. */
export function leaderboardErrorName(code: number): LeaderboardErrorName | undefined {
  return LEADERBOARD_ERROR_NAMES.get(code);
}

/** Escrow `Winner` enum variants. */
export const ESCROW_WINNERS = ['Player1', 'Player2', 'Draw'] as const;
export type EscrowWinner = (typeof ESCROW_WINNERS)[number];

/** The backend's result names, mapped to the contract's `Winner` variants. */
export function toEscrowWinner(result: MatchResult): EscrowWinner {
  switch (result) {
    case 'Player1Wins':
      return 'Player1';
    case 'Player2Wins':
      return 'Player2';
    case 'Draw':
      return 'Draw';
  }
}

/** A unit `#[contracttype]` enum value is encoded as a one-symbol vector. */
export function unitEnumToScVal(variant: string): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(variant)]);
}

/** Escrow methods the backend invokes, with their argument order. */
export const BACKEND_ESCROW_METHODS = {
  submit_result: ['match_id', 'game_id', 'winner', 'caller'],
  add_token: ['token'],
  remove_token: ['token'],
  get_escrow_balance: ['match_id'],
  get_escrow_balance_by_token: ['match_id', 'token'],
} as const;

export interface SubmitResultArgs {
  matchId: number | bigint;
  gameId: string;
  result: MatchResult;
  /** The oracle's account address (G...). */
  caller: string;
}

/** Arguments for `submit_result(match_id: u64, game_id: String, winner: Winner, caller: Address)`. */
export function serializeSubmitResultArgs(args: SubmitResultArgs): xdr.ScVal[] {
  return [
    nativeToScVal(BigInt(args.matchId), { type: 'u64' }),
    nativeToScVal(args.gameId, { type: 'string' }),
    unitEnumToScVal(toEscrowWinner(args.result)),
    new Address(args.caller).toScVal(),
  ];
}

export interface AddTokenArgs {
  /** The token contract address (C...). */
  token: string;
}

/** Arguments for `add_token(token: Address)`. */
export function serializeAddTokenArgs(args: AddTokenArgs): xdr.ScVal[] {
  return [new Address(args.token).toScVal()];
}

export interface RemoveTokenArgs {
  /** The token contract address (C...). */
  token: string;
}

/** Arguments for `remove_token(token: Address)`. */
export function serializeRemoveTokenArgs(args: RemoveTokenArgs): xdr.ScVal[] {
  return [new Address(args.token).toScVal()];
}

export interface GetEscrowBalanceArgs {
  matchId: number | bigint;
}

/** Arguments for `get_escrow_balance(match_id: u64)`. */
export function serializeGetEscrowBalanceArgs(args: GetEscrowBalanceArgs): xdr.ScVal[] {
  return [nativeToScVal(BigInt(args.matchId), { type: 'u64' })];
}

export interface GetEscrowBalanceByTokenArgs {
  matchId: number | bigint;
  /** The token contract address (C...). */
  token: string;
}

/** Arguments for `get_escrow_balance_by_token(match_id: u64, token: Address)`. */
export function serializeGetEscrowBalanceByTokenArgs(
  args: GetEscrowBalanceByTokenArgs,
): xdr.ScVal[] {
  return [nativeToScVal(BigInt(args.matchId), { type: 'u64' }), new Address(args.token).toScVal()];
}

/**
 * Per-token escrow balances returned by `get_escrow_balance`, keyed by token
 * contract address. Each token's balance is tracked independently.
 */
export type TokenBalances = Record<string, bigint>;

/**
 * Decode the `Map<Address, i128>` returned by `get_escrow_balance` into a
 * {@link TokenBalances} record. Accepts either a raw `xdr.ScVal` or an already
 * converted value (e.g. from a Soroban RPC `scValToNative` call).
 */
export function decodeTokenBalances(value: xdr.ScVal | unknown): TokenBalances {
  const balances: TokenBalances = {};
  const entries = extractMapEntries(value);
  for (const [key, amount] of entries) {
    balances[tokenKeyToString(key)] = toBigInt(amount);
  }
  return balances;
}

/** Sum the balances across all tokens in a {@link TokenBalances} record. */
export function totalTokenBalance(balances: TokenBalances): bigint {
  let total = 0n;
  for (const amount of Object.values(balances)) total += amount;
  return total;
}

function extractMapEntries(value: xdr.ScVal | unknown): Array<[unknown, unknown]> {
  if (value instanceof xdr.ScVal) {
    switch (value.switch()) {
      case xdr.ScValType.scvMap(): {
        const map = value.map();
        return map ? map.map((entry) => [entry.key(), entry.val()]) : [];
      }
      case xdr.ScValType.scvVec(): {
        const vec = value.vec();
        return vec ? vec.map((entry) => extractMapEntry(entry)) : [];
      }
      default:
        return [];
    }
  }
  if (value instanceof Map) return Array.from(value.entries());
  if (Array.isArray(value)) return value.map((entry) => extractMapEntry(entry));
  if (value && typeof value === 'object') return Object.entries(value);
  return [];
}

function extractMapEntry(entry: unknown): [unknown, unknown] {
  if (entry instanceof xdr.ScVal) {
    const entries = extractMapEntries(entry);
    if (entries.length === 1) return entries[0];
  }
  if (Array.isArray(entry) && entry.length === 2) return [entry[0], entry[1]];
  return [entry, 0n];
}

function tokenKeyToString(key: unknown): string {
  if (key instanceof xdr.ScVal) {
    if (key.switch() === xdr.ScValType.scvAddress()) {
      return Address.fromScVal(key).toString();
    }
    return key.value()?.toString() ?? '';
  }
  if (key && typeof key === 'object' && 'toString' in key) return String(key);
  return String(key);
}

function toBigInt(amount: unknown): bigint {
  if (typeof amount === 'bigint') return amount;
  if (amount instanceof xdr.ScVal) {
    const native = amount.value();
    if (typeof native === 'bigint') return native;
    if (native && typeof native === 'object' && 'toString' in native) {
      return BigInt(native.toString());
    }
    return 0n;
  }
  if (typeof amount === 'number') return BigInt(Math.trunc(amount));
  if (typeof amount === 'string' && amount.length > 0) return BigInt(amount);
  if (amount && typeof amount === 'object' && 'toString' in amount) {
    return BigInt(amount.toString());
  }
  return 0n;
}
