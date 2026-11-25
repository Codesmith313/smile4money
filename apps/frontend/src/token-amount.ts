import { Asset, Networks } from '@stellar/stellar-sdk';

/**
 * Default number of decimals for Stellar native (XLM) amounts.
 * Stellar native amounts have seven decimals:
 * https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/assets
 */
export const NATIVE_DECIMALS = 7;

/**
 * The common base unit used by the contract. All token amounts are normalized
 * to this many decimals before arithmetic so that tokens with varying decimal
 * configurations (6, 7, 8, etc.) can be compared and combined accurately.
 */
export const BASE_DECIMALS = 7;

const TEN = 10n;

function pow10(exponent: number): bigint {
  if (!Number.isInteger(exponent) || exponent < 0) {
    throw new RangeError(`Invalid decimal exponent: ${exponent}`);
  }
  return TEN ** BigInt(exponent);
}

/**
 * Formats a raw integer amount (in the token's smallest units) as a human
 * readable decimal string. When `decimals` is 7 (the default) and the token is
 * the native SAC for a known network, the output matches the historical XLM
 * formatting exactly.
 */
export function formatTokenAmount(
  raw: string,
  token: string,
  passphrase: string,
  decimals: number = NATIVE_DECIMALS,
): string {
  const knownNetwork = passphrase === Networks.TESTNET || passphrase === Networks.PUBLIC;
  const isNative = knownNetwork && token === Asset.native().contractId(passphrase);

  if (!isNative || decimals !== NATIVE_DECIMALS) {
    const suffix = isNative ? 'XLM' : token || 'unknown asset';
    if (decimals === NATIVE_DECIMALS) {
      return `${raw} smallest units (${suffix})`;
    }
    return `${raw} smallest units (${suffix}, ${decimals} decimals)`;
  }

  const amount = BigInt(raw);
  const scale = pow10(decimals);
  const absolute = amount < 0n ? -amount : amount;
  const fraction = (absolute % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${amount < 0n ? '-' : ''}${absolute / scale}${fraction ? `.${fraction}` : ''} XLM`;
}

/**
 * Normalizes a raw token amount (smallest units for a token with `decimals`
 * decimals) into the contract's common base unit (BASE_DECIMALS decimals).
 *
 * Rounding policy: amounts that cannot be represented exactly in the base unit
 * (i.e. the token has more decimals than the base unit and the extra digits are
 * non-zero) are REJECTED with a RangeError rather than silently rounded. This
 * keeps arithmetic lossless and avoids hidden value drift. Callers that need to
 * accept lossy conversions should round explicitly before calling this helper.
 *
 * Tokens with fewer decimals than the base unit are scaled up exactly.
 */
export function normalizeToBase(raw: string, decimals: number): bigint {
  const amount = BigInt(raw);
  if (decimals === BASE_DECIMALS) {
    return amount;
  }
  if (decimals < BASE_DECIMALS) {
    return amount * pow10(BASE_DECIMALS - decimals);
  }
  const divisor = pow10(decimals - BASE_DECIMALS);
  if (amount % divisor !== 0n) {
    throw new RangeError(
      `Amount ${raw} with ${decimals} decimals is not representable in the ${BASE_DECIMALS}-decimal base unit`,
    );
  }
  return amount / divisor;
}

/**
 * Converts an amount expressed in the contract's common base unit
 * (BASE_DECIMALS decimals) back into the token's smallest units for a token
 * with `decimals` decimals.
 *
 * Rounding policy: when the token has fewer decimals than the base unit, the
 * result is rounded DOWN (towards zero) to the nearest representable token
 * amount. This is documented and deterministic; callers requiring exactness
 * should verify the result by re-normalizing.
 */
export function denormalizeFromBase(baseAmount: bigint, decimals: number): bigint {
  if (decimals === BASE_DECIMALS) {
    return baseAmount;
  }
  if (decimals > BASE_DECIMALS) {
    return baseAmount * pow10(decimals - BASE_DECIMALS);
  }
  const divisor = pow10(BASE_DECIMALS - decimals);
  // BigInt division truncates towards zero, which is round-down for positives
  // and round-towards-zero for negatives.
  return baseAmount / divisor;
}