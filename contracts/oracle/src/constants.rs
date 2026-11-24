//! Policy constants for the oracle contract.
//!
//! The ledger durations and identifier limits are defined once in
//! [`smile4money_common::constants`] and re-exported here, so the oracle can
//! never drift away from the escrow contract's deadlines. `lib.rs` does
//! `pub use constants::*`, which keeps the existing `crate::MATCH_TTL_LEDGERS`
//! path used by the unit tests working unchanged.

pub use smile4money_common::constants::{
    LEDGERS_PER_DAY, LEDGERS_PER_WEEK, MATCH_TTL_LEDGERS, MAX_GAME_ID_LEN, SECONDS_PER_DAY,
    SECONDS_PER_LEDGER, SECONDS_PER_WEEK,
};

/// Maximum number of entries returned by `list_results` in a single call.
///
/// **Source:** policy decided by this repository to bound the response size of a
/// single read so that listing can never exceed a Soroban transaction's
/// resource limits. See `docs/api-reference.md`.
pub const MAX_LIST_LIMIT: u32 = 100;

/// Maximum tolerated clock skew, in seconds, when validating a result
/// timestamp against the current ledger time.
///
/// A result timestamp must not be later than the current ledger time. To
/// account for minor differences between the oracle's wall clock and the
/// ledger close time, timestamps up to this many seconds in the future are
/// still accepted. Anything beyond this window is rejected as a future
/// timestamp.
///
/// **Source:** policy decided by this repository to keep result timestamp
/// validation tolerant of small clock drift while still rejecting clearly
/// future timestamps.
pub const MAX_RESULT_TIMESTAMP_SKEW_SECONDS: u64 = 60;

/// Maximum length, in bytes, of a result nonce.
///
/// Nonces are used for replay protection: each accepted result carries a
/// nonce that must be unique per match. This bound keeps the nonce small
/// enough to be stored and compared cheaply on-chain.
///
/// **Source:** policy decided by this repository to bound the storage and
/// comparison cost of replay-protection nonces.
pub const MAX_RESULT_NONCE_LEN: u32 = 64;

/// Minimum length, in bytes, of a result nonce.
///
/// An empty nonce would provide no replay protection, so nonces shorter than
/// this are rejected.
///
/// **Source:** policy decided by this repository to ensure nonces carry
/// enough entropy to be meaningful.
pub const MIN_RESULT_NONCE_LEN: u32 = 1;