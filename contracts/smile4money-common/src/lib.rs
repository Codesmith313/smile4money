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

#![no_std]

pub mod constants;

use soroban_sdk::contracterror;

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
/// | 35   | InsufficientPermission | Caller's role lacks the permission required for this action |
/// | 40   | TokenNotSep41      | Token does not implement the required SEP-41 interface         |
/// | 41   | InvalidTokenMetadata | Token metadata is missing or failed validation                |
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

    /// [E035] The caller's role does not grant the permission required for this action.
    InsufficientPermission = 35,

    /// [E040] The token does not implement the required SEP-41 (Stellar Asset Contract) interface.
    TokenNotSep41 = 40,

    /// [E041] The token metadata is missing or failed validation.
    InvalidTokenMetadata = 41,
}
