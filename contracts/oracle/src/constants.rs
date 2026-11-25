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

/// Domain separator prefixed to the reconstructed message when verifying a
/// game result proof.
///
/// The signed message is built as
/// `PROOF_DOMAIN_SEPARATOR || game_id || winner || timestamp`, which prevents a
/// signature produced for one context (e.g. a raw transfer) from being replayed
/// as a game result proof. See `docs/api-reference.md`.
pub const PROOF_DOMAIN_SEPARATOR: &[u8] = b"smile4money:game-result:v1";

/// Maximum accepted length, in bytes, of a game result proof.
///
/// Bounds the amount of data a caller can push through verification so that a
/// single `submit_result` call can never exceed a Soroban transaction's
/// resource limits. A 64-byte Ed25519 signature fits comfortably within this
/// limit, as does a 32-byte hash-based proof.
pub const MAX_PROOF_LEN: u32 = 128;