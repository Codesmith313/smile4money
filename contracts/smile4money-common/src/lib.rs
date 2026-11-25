//! # smile4money-common
//!
//! Shared types and error variants used by the escrow and oracle Soroban contracts.
//!
//! ## Error codes
//!
//! Error codes are **stable on-chain identifiers**. Do **not** renumber existing variants —
//! doing so is a breaking change for any client that inspects the raw error code.
//!
//! Each contract has its own `Error` enum (required by `#[contracterror]`) but imports
//! shared variants from [`SharedError`] and implements `From<SharedError>` to allow
//! transparent conversion with the `?` operator.
//!
//! ## Constants
//!
//! Ledger-duration and identifier constants shared by the escrow and oracle
//! contracts live in [`constants`] so that both contracts — and the frontend —
//! agree on a single set of values.
//!
//! ## Token decimals normalization
//!
//! Tokens may use different decimal configurations (e.g. 6, 7, or 8 decimals).
//! To perform accurate arithmetic across tokens, all amounts are normalized to a
//! common base unit defined by [`BASE_DECIMALS`] (7 decimals, matching Stellar's
//! native precision). [`MAX_TOKEN_DECIMALS`] bounds the decimals a supported token
//! may declare; tokens exceeding it are rejected.
//!
//! ### Rounding policy
//!
//! When converting an amount from a token's native decimals to the base unit
//! (scaling **up**, i.e. `token_decimals <= BASE_DECIMALS`), the amount is
//! multiplied by `10^(BASE_DECIMALS - token_decimals)` — this is exact and loses
//! no precision.
//!
//! When converting from the base unit back down to a token's native decimals
//! (scaling **down**, i.e. `token_decimals < BASE_DECIMALS`), the result is
//! truncated toward zero (floor for non-negative amounts). Any fractional
//! remainder below the token's smallest unit is discarded. Callers that require
//! exact conservation of value should keep balances in the base unit and only
//! convert at the token-transfer boundary.
//!
//! Conversions between tokens with the same decimals are identity operations.

#![no_std]

pub mod constants;

use soroban_sdk::contracterror;

pub use constants::{BASE_DECIMALS, MAX_TOKEN_DECIMALS};

/// Error variants that are shared across the escrow and oracle contracts.
///
/// These codes are the **canonical** values for each shared concept. Both contracts
/// must use the same numeric discriminant for the same semantic error.
///
/// # Shared error code table
///
/// | Code | Variant            | Meaning                                                        |
/// |------|--------------------|----------------------------------------------------------------|
/// |  4   | Unauthorized       | Caller is not permitted to perform this action                 |
/// |  7   | AlreadyInitialized | Contract has already been initialized                          |
/// | 10   | InvalidAmount      | Amount must be greater than zero                               |
/// | 11   | InvalidGameId      | game_id is empty, exceeds 64 bytes, or contains invalid chars  |
/// | 15   | TransferFailed     | Token transfer failed                                          |
/// | 23   | InvalidAdmin       | The admin address is invalid (zero address or same as current) |
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum SharedError {
    /// [E004] Caller is not the oracle, admin, or an authorised player for this operation.
    Unauthorized = 4,

    /// [E007] `initialize` has already been called; the contract cannot be re-initialized.
    AlreadyInitialized = 7,

    /// [E010] Amount must be a positive integer greater than zero.
    InvalidAmount = 10,

    /// [E011] `game_id` is empty, exceeds the 64-byte maximum length, or contains
    /// characters outside the allowed set `[A-Za-z0-9_-]`.
    InvalidGameId = 11,

    /// [E015] Token transfer failed.
    TransferFailed = 15,

    /// [E023] The admin address is invalid (e.g. zero address or same as current admin).
    InvalidAdmin = 23,
}