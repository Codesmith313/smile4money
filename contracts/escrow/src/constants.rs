//! Policy constants for the escrow contract.
//!
//! # Single source of truth
//!
//! Every ledger duration in the escrow contract comes from
//! [`smile4money_common::constants`] and is re-exported here, so this module is
//! the only place a reader needs to look. `lib.rs` does `pub use constants::*`,
//! which keeps the existing `crate::MATCH_TTL_LEDGERS` / `crate::MIN_STAKE`
//! paths (used by the unit tests) working unchanged.
//!
//! # Sources
//!
//! - Stellar ledger close time (~5 s average) and ledger lifecycle:
//!   <https://developers.stellar.org/docs/encyclopedia/security-and-property-guides/ledger-anatomy>
//! - `extend_ttl` threshold / extend-to semantics:
//!   <https://developers.stellar.org/docs/build/guides/storage/extend-bump-lifetimes>
//! - Network limits (`max_entry_ttl`):
//!   <https://developers.stellar.org/docs/network/limits>
//! - Dispute window and match timeout policy: ADR-001
//!   (`docs/adr/001-dispute-window.md`)
//! - Minimum account balance / base reserve:
//!   <https://developers.stellar.org/docs/encyclopedia/security-and-property-guides/minimum-account-balance>

// Shared ledger durations. Defined in `smile4money-common` so the oracle and the
// frontend can share them; re-exported here because the escrow contract is
// where these deadlines are actually enforced.
pub use smile4money_common::constants::{
    DEFAULT_TIMEOUT_LEDGERS, DISPUTE_WINDOW_LEDGERS, LEDGERS_PER_DAY, LEDGERS_PER_WEEK, MAX_GAME_ID_LEN,
    MATCH_TTL_LEDGERS, SECONDS_PER_DAY, SECONDS_PER_LEDGER, SECONDS_PER_WEEK, TIMEOUT_LEDGERS,
};

/// Minimum stake amount in the smallest token unit (1 stroop).
///
/// **Source:** policy decided by this repository; prevents economically
/// meaningless zero-stake matches. See `docs/issue-3-zero-stake-guard.md`.
pub const MIN_STAKE: i128 = 1;

/// Maximum stake amount in the smallest token unit.
///
/// **Source:** policy decided by this repository; prevents a single match from
/// locking unbounded funds in escrow, concentrating risk, and amplifying the
/// impact of any exploit. The exact ceiling is recorded in
/// `docs/api-reference.md`.
pub const MAX_STAKE: i128 = 10_000_000_000_000;

/// Instance-storage TTL threshold: ~30 days (`518_400` ledgers).
///
/// **Source:** uses the same 30-day retention window as
/// [`MATCH_TTL_LEDGERS`], expressed in ledgers via the Stellar 5 s/ledger
/// average. Instance entries (oracle, admin, token, paused, match_count) are
/// bumped on every write; without this they would expire and the contract would
/// fail with storage-not-found errors.
///
/// <https://developers.stellar.org/docs/build/guides/storage/extend-bump-lifetimes>
pub const INSTANCE_LIFETIME_THRESHOLD: u32 = MATCH_TTL_LEDGERS;

/// Number of ledgers instance-storage entries are extended to.
///
/// **Source:** same 30-day window as [`INSTANCE_LIFETIME_THRESHOLD`] and
/// [`MATCH_TTL_LEDGERS`], so an instance entry and the persistent match entry
/// it describes always expire together.
///
/// <https://developers.stellar.org/docs/build/guides/storage/extend-bump-lifetimes>
pub const INSTANCE_BUMP_AMOUNT: u32 = MATCH_TTL_LEDGERS;

/// Reserve buffer (in stroops) the contract must always retain **after** a
/// payout, to satisfy Stellar's minimum-account-balance rule and leave a small
/// operational safety margin.
///
/// Every Stellar account (including the address backing a Soroban contract)
/// must hold at least 2 base reserves = **1 XLM** just to exist on the ledger.
/// If an escrow payout dropped the contract below that threshold, the underlying
/// `PAYMENT` / `transfer` op would abort and leave the match state machine
/// inconsistent (state not advanced, funds not sent).
///
/// **Source:** Stellar minimum account balance
/// (<https://developers.stellar.org/docs/encyclopedia/security-and-property-guides/minimum-account-balance>)
/// and the base-reserve value documented in `docs/deployment.md`. The 0.5 XLM of
/// slack on top of the 1 XLM minimum is a policy choice by this repository.
///
/// `15_000_000` stroops = 1.5 XLM (1 XLM minimum base reserve + 0.5 XLM slack).
/// For non-native tokens (e.g. USDC) the same constant still serves as a floor;
/// the real XLM minimum is provided by a separate admin-funded native top-up
/// (see `docs/deployment.md`).
pub const ESCROW_RESERVE_BUFFER_STROOPS: i128 = 15_000_000;

/// Number of decimals in the common base unit all token amounts are normalized
/// to for arithmetic inside the contract.
///
/// **Source:** policy decided by this repository. 7 decimals matches Stellar's
/// native asset (1 XLM = 10^7 stroops), so native-token amounts need no scaling
/// and every other token is scaled up/down relative to that same base. See
/// [`MAX_TOKEN_DECIMALS`] and the rounding policy below.
pub const BASE_DECIMALS: u32 = 7;

/// Upper bound on the number of decimals a token registered via `add_token`
/// may report. Tokens with more decimals are rejected at registration time so
/// that normalization can never overflow the `i128` amount type.
///
/// **Source:** policy decided by this repository; `10^18` is the largest power
/// of ten that keeps scaled amounts within `i128` for realistic balances.
pub const MAX_TOKEN_DECIMALS: u32 = 18;

/// Rounding policy for decimal normalization.
///
/// All token amounts are converted to the common base unit
/// ([`BASE_DECIMALS`] decimals) before any arithmetic:
///
/// - **Scaling up** (token decimals < [`BASE_DECIMALS`]) is exact: the amount is
///   multiplied by `10^(BASE_DECIMALS - token_decimals)`.
/// - **Scaling down** (token decimals > [`BASE_DECIMALS`]) **rounds down**
///   (truncates toward zero) on deposit, so the contract never credits more
///   base units than were actually transferred in.
/// - **Non-representable amounts are rejected**: a deposit whose amount is not
///   an exact multiple of `10^(token_decimals - BASE_DECIMALS)` would lose
///   precision, so it fails with an error instead of being silently truncated.
///
/// This keeps every stored amount an exact multiple of one base unit and makes
/// conversions deterministic and lossless in the direction that matters
/// (crediting the user).
pub const ROUNDING_POLICY: RoundingPolicy = RoundingPolicy::RoundDownRejectInexact;

/// Rounding behaviour applied when normalizing token amounts to
/// [`BASE_DECIMALS`]. See [`ROUNDING_POLICY`] for the documented policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RoundingPolicy {
    /// Round down (truncate toward zero) on deposit and reject amounts that are
    /// not exactly representable in the base unit.
    RoundDownRejectInexact,
}
