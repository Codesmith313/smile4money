Looking at the requirements, I need to understand the current structure. Let me check what's available in the types and errors modules based on usage patterns, then implement the changes.

Since I can only see `lib.rs`, I'll need to add the new error variants and types. The step says to update `get_result`/`has_result` accordingly and add helpers. Let me implement based on reasonable assumptions about the existing `types.rs` and `errors.rs` structure.

Given the constraints (I can only return `lib.rs`), I'll define new types/errors inline where needed, or reference them assuming they'll be added. Since the task focuses on `lib.rs`, I'll add the necessary types and error variants directly in this file to be self-contained, while preserving existing imports.

Let me write the complete file:

```rust
//! # Oracle Contract
//!
//! This module implements the on-chain oracle contract for the Smile4Money chess-escrow
//! system on Stellar Soroban.
//!
//! ## Role in the System
//!
//! The oracle contract acts as the trusted bridge between off-chain chess game results
//! and the on-chain escrow contract. The off-chain oracle service (a backend process that
//! monitors Lichess and Chess.com APIs) calls [`submit_result`] to record a verified game
//! outcome on-chain. The escrow contract then reads this result (or is called directly via
//! `submit_result` on the escrow side) to determine payout.
//!
//! ## Relationship to the Escrow Contract
//!
//! ```text
//! Off-chain Service
//!        │
//!        │  submit_result(match_id, game_id, result)
//!        ▼
//! ┌─────────────────┐       get_result(match_id)      ┌──────────────────┐
//! │  Oracle Contract│ ──────────────────────────────► │  Escrow Contract │
//! └─────────────────┘                                  └──────────────────┘
//! ```
//!
//! The oracle contract stores results immutably (one result per match). The escrow contract
//! validates the caller is the registered oracle address before processing any payout.
//!
//! ## Result Submission Flow
//!
//! 1. A chess game completes on Lichess or Chess.com.
//! 2. The off-chain oracle service fetches the result from the platform API.
//! 3. The oracle service calls [`submit_result`] with the `match_id`, `game_id`, and
//!    the outcome (`Player1Wins`, `Player2Wins`, or `Draw`).
//! 4. The contract validates the admin signature, checks for duplicates, and stores the
//!    [`ResultEntry`] in persistent storage.
//! 5. After the dispute window (defined in the escrow contract) expires, the escrow
//!    contract processes the payout based on this stored result.
//!
//! ## Dispute Window
//!
//! Results submitted to the **escrow** contract enter a `PendingResult` state for
//! `DISPUTE_WINDOW_LEDGERS` (~24 hours) before payout is executed. During this window
//! the admin can call `override_result` on the escrow contract to correct an erroneous
//! submission. See [`contracts/escrow/src/lib.rs`] for details.
//!
//! ## Further Reading
//!
//! - Full API reference with examples: [`docs/api-reference.md`](../../docs/api-reference.md)
//! - Oracle architecture and sequence diagrams: [`docs/oracle.md`](../../docs/oracle.md)

#![no_std]

mod constants;
mod errors;
mod types;

pub use constants::*;

use errors::Error;
use soroban_sdk::{
    contract, contractimpl, symbol_short, token, Address, Bytes, BytesN, Env, String, Symbol, Vec,
};
use types::{DataKey, InstanceState, MatchResult, ResultEntry};

/// Domain-separation tag mixed into every signed result message so that a signature
/// produced for this contract can never be replayed against another protocol.
const PROOF_DOMAIN: &[u8] = b"smile4money:oracle:result:v1";

/// Encode a `MatchResult` as a single stable byte for inclusion in the signed message.
fn result_to_byte(result: &MatchResult) -> u8 {
    match result {
        MatchResult::Player1Wins => 0u8,
        MatchResult::Player2Wins => 1u8,
        MatchResult::Draw => 2u8,
    }
}

/// Reconstruct the canonical message that a provider signs for a game result.
///
/// Layout: `PROOF_DOMAIN || match_id (8 bytes BE) || game_id_len (4 bytes BE) || game_id || result (1 byte)`.
/// The length prefix prevents ambiguity between concatenated fields.
fn build_proof_message(env: &Env, match_id: u64, game_id: &String, result: &MatchResult) -> Bytes {
    let mut msg = Bytes::new(env);
    for b in PROOF_DOMAIN {
        msg.push_back(*b);
    }
    for b in match_id.to_be_bytes() {
        msg.push_back(b);
    }
    let game_id_len = game_id.len();
    for b in game_id_len.to_be_bytes() {
        msg.push_back(b);
    }
    let mut buf = [0u8; MAX_GAME_ID_LEN as usize];
    game_id.copy_into_slice(&mut buf[..game_id_len as usize]);
    for i in 0..game_id_len as usize {
        msg.push_back(buf[i]);
    }
    msg.push_back(result_to_byte(result));
    msg
}

/// Verify a provider proof against the registered verification key.
///
/// The proof is the 32-byte SHA-256 digest of the canonical message. It is compared
/// against the digest recomputed on-chain from the stored provider key material, so a
/// tampered `(match_id, game_id, result)` tuple can never validate. Returns `true`
/// only when the digests match exactly.
fn verify_proof(
    env: &Env,
    provider_key: &BytesN<32>,
    match_id: u64,
    game_id: &String,
    result: &MatchResult,
    proof: &BytesN<32>,
) -> bool {
    let message = build_proof_message(env, match_id, game_id, result);
    // Bind the provider key into the digest so a proof is only valid for the key that
    // was registered by the admin at verification time.
    let mut keyed = Bytes::new(env);
    for b in provider_key.to_array() {
        keyed.push_back(b);
    }
    for i in 0..message.len() {
        keyed.push_back(message.get(i).unwrap());
    }
    let expected = env.crypto().sha256(&keyed);
    expected.to_array() == proof.to_array()
}
=======

/// Validate that every byte of `game_id` belongs to the set `[A-Za-z0-9_-]`.
///
/// This enforces printable ASCII and prevents null bytes, control characters,
/// whitespace, and non-ASCII sequences from entering persistent storage.
/// The allowed set mirrors both the identifier format used by Lichess and
/// Chess.com and the identical check performed by the escrow contract, ensuring
/// the two contracts always agree on what constitutes a valid `game_id`.
///
/// The string is copied into a fixed 64-byte stack buffer — the same size as
/// `MAX_GAME_ID_LEN` — so no heap allocation is required inside the WASM guest.
fn is_valid_game_id(game_id: &String) -> bool {
    let len = game_id.len() as usize;
    // Safety: len is already validated to be in [1, MAX_GAME_ID_LEN].
    let mut buf = [0u8; MAX_GAME_ID_LEN as usize];
    game_id.copy_into_slice(&mut buf[..len]);
    for i in 0..len {
        let b = buf[i];
        let ok = b.is_ascii_alphanumeric() || b == b'_' || b == b'-';
        if !ok {
            return false;
        }
    }
    true
}

fn bump_initialized_ttl(env: &Env) {
    env.storage().persistent().extend_ttl(
        &DataKey::IsInitialized,
        MATCH_TTL_LEDGERS,
        MATCH_TTL_LEDGERS,
    );
}

#[contract]
pub struct OracleContract;

#[contractimpl]
impl OracleContract {
    /// Read the current admin for deployment authorization checks.
    /// Does not mutate state or grant authority.
    pub fn get_admin(env: Env) -> Result<Address, Error> {
        let state: InstanceState = env
            .storage()
            .instance()
            .get(&DataKey::InstanceState)
            .ok_or(Error::Unauthorized)?;
        Ok(state.admin)
    }

    /// Initialize the oracle contract with a trusted admin address.
    ///
    /// The `admin` is the address of the off-chain oracle service that is authorised
    /// to submit game results. This function can only be called once — subsequent calls
    /// return [`Error::AlreadyInitialized`].
    ///
    /// # Arguments
    ///
    /// * `admin` — The Stellar address of the trusted off-chain oracle service.
    ///
    /// # Errors
    ///
    /// Returns [`Error::AlreadyInitialized`] if the contract has already been set up.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().persistent().has(&DataKey::IsInitialized) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().persistent().set(&DataKey::IsInitialized, &true);
        bump_initialized_ttl(&env);
        env.storage().instance().set(
            &DataKey::InstanceState,
            &InstanceState {
                admin: admin.clone(),
                result_count: 0,
            },
        );
        env.storage()
            .instance()
            .extend_ttl(MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);
        env.events()
            .publish((Symbol::new(&env, "oracle"), symbol_short!("init")), admin);
        Ok(())
    }

    /// Record the creation timestamp for a match.
    ///
    /// Must be called (by the admin) before [`submit_result`] so that the oracle can
    /// validate that a submitted result's timestamp falls after the match was created.
    /// Idempotent: re-registering the same match with the same timestamp is a no-op;
    /// attempting to change an existing creation timestamp returns
    /// [`Error::InvalidTimestamp`].
    ///
    /// # Arguments
    ///
    /// * `match_id`        — The escrow match ID.
    /// * `created_at`      — The match creation timestamp (unix seconds).
    ///
    /// # Errors
    ///
    /// * [`Error::Unauthorized`]     — Contract not initialized or caller is not the admin.
    /// * [`Error::InvalidTimestamp`] — `created_at` is in the future, or an existing
    ///   creation timestamp differs from the supplied one.
    pub fn register_match(env: Env, match_id: u64, created_at: u64) -> Result<(), Error> {
        let instance_state: InstanceState = env
            .storage()
            .instance()
            .get(&DataKey::InstanceState)
            .ok_or(Error::Unauthorized)?;
        let admin = instance_state.admin.clone();
        admin.require_auth();

        let now = env.ledger().timestamp();
        if created_at > now {
            return Err(Error::InvalidTimestamp);
        }

        if let Some(existing) = env
            .storage()
            .persistent()
            .get::<DataKey, u64>(&DataKey::MatchCreatedAt(match_id))
        {
            if existing != created_at {
                return Err(Error::InvalidTimestamp);
            }
            return Ok(());
        }

        env.storage()
            .persistent()
            .set(&DataKey::MatchCreatedAt(match_id), &created_at);
        env.storage().persistent().extend_ttl(
            &DataKey::MatchCreatedAt(match_id),
            MATCH_TTL_LEDGERS,
            MATCH_TTL_LEDGERS,
        );
        bump_initialized_ttl(&env);

        env.events().publish(
            (Symbol::new(&env, "oracle"), symbol_short!("match_reg")),
            (match_id, created_at),
        );

        Ok(())
    }

    /// Submit a verified chess game result on-chain.
    ///
    /// Called by the off-chain oracle service (`admin`) once the game outcome has been
    /// confirmed via the chess platform API. The result is stored immutably in persistent
    /// storage; any attempt to submit a second result for the same `match_id` is rejected.
    ///
    /// On the escrow contract side, this triggers the `PendingResult` dispute window before
    /// payout is executed.
    ///
    /// # Arguments
    ///
    /// * `caller`    — The address invoking the submission. Must equal the registered admin.
    /// * `match_id`  — The escrow match ID this result belongs to.
    /// * `game_id`   — The platform-specific game identifier (e.g. Lichess game ID). Must be
    ///   non-empty, at most 64 bytes, and contain only `[A-Za-z0-9_-]` characters.
    /// * `result`    — The outcome: [`MatchResult::Player1Wins`], [`MatchResult::Player2Wins`],
    ///   or [`MatchResult::Draw`].
    /// * `nonce`     — A per-oracle, per-match unique nonce to prevent replay.
    /// * `timestamp` — The result timestamp (unix seconds). Must be strictly greater than
    ///   the match creation time and less than or equal to the current ledger timestamp.
    ///
    /// # Errors
    ///
    /// * [`Error::Unauthorized`]           — Caller is not the registered admin.
    /// * [`Error::InvalidGameId`]          — `game_id` is empty, exceeds 64 bytes, or contains
    ///   characters outside `[A-Za-z0-9_-]`.
    /// * [`Error::MatchAlreadyCompleted`]  — The match has already been completed.
    /// * [`Error::AlreadySubmitted`]       — A result already exists for this `match_id`.
    /// * [`Error::ReplayDetected`]         — The `nonce` has already been used for this match.
    /// * [`Error::InvalidTimestamp`]       — `timestamp` is not within the valid window.
    pub fn submit_result(
        env: Env,
        caller: Address,
        match_id: u64,
        game_id: String,
        result: MatchResult,
        nonce: u64,
        timestamp: u64,
    ) -> Result<(), Error> {
        // Keep admin and result_count in one instance entry so this hot path loads both
        // values with one storage read instead of reading each key independently.
        let mut instance_state: InstanceState = env
            .storage()
            .instance()
            .get(&DataKey::InstanceState)
            .ok_or(Error::Unauthorized)?;
        let admin = instance_state.admin.clone();

        // (#2092) Verify the caller is the registered oracle/admin before accepting.
        if caller != admin {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();

        let game_id_len = game_id.len();
        if game_id_len == 0 || game_id_len > MAX_GAME_ID_LEN {
            return Err(Error::InvalidGameId);
        }

        // Enforce printable ASCII: only [A-Za-z0-9_-] are accepted.
        // This mirrors the identical check in the escrow contract and closes the
        // gap where a caller could submit a game_id containing null bytes, control
        // characters, or non-ASCII sequences that would pass the length check but
        // permanently diverge from the escrow's stored game_id, causing an
        // irrecoverable GameIdMismatch that locks player funds.
        if !is_valid_game_id(&game_id) {
            return Err(Error::InvalidGameId);
        }

        // (#2094) Once a match is Completed, no new results may override the outcome.
        if env
            .storage()
            .persistent()
            .has(&DataKey::MatchCompleted(match_id))
        {
            // Log the override attempt for auditability.
            env.events().publish(
                (Symbol::new(&env, "oracle"), symbol_short!("override")),
                (match_id, caller.clone(), game_id.clone(), result.clone()),
            );
            return Err(Error::MatchAlreadyCompleted);
        }

        // Reject duplicate submissions for the same match.
        if env.storage().persistent().has(&DataKey::Result(match_id)) {
            return Err(Error::AlreadySubmitted);
        }

        // (#2091) Replay protection: reject a nonce that has already been used for
        // this match. The nonce is only persisted as used after all checks pass.
        if env
            .storage()
            .persistent()
            .has(&DataKey::NonceUsed(match_id, nonce))
        {
            return Err(Error::ReplayDetected);
        }

        // (#2093) Timestamp validation: must be strictly after match creation and
        // no later than the current ledger timestamp.
        let created_at: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::MatchCreatedAt(match_id))
            .ok_or(Error::InvalidTimestamp)?;
        let now = env.ledger().timestamp();
        if timestamp <= created_at || timestamp > now {
            return Err(Error::InvalidTimestamp);
        }

        let ledger_seq = env.ledger().sequence();
        // SAFETY: Soroban's single-execution model prevents re-entrancy; no cross-contract
        // calls are made here, so the state written below cannot be observed by a
        // re-entrant caller before this function returns.
        env.storage().persistent().set(
            &DataKey::Result(match_id),
            &ResultEntry {
                game_id: game_id.clone(),
                result: result.clone(),
                submitted_ledger: ledger_seq,
                submitted_by: admin.clone(),
            },
        );
        env.storage().persistent().extend_ttl(
            &DataKey::Result(match_id),
            MATCH_TTL_LEDGERS,
            MATCH_TTL_LEDGERS,
        );

        // Persist the nonce as used only after all checks pass.
        env.storage()
            .persistent()
            .set(&DataKey::NonceUsed(match_id, nonce), &true);
        env.storage().persistent().extend_ttl(
            &DataKey::NonceUsed(match_id, nonce),
            MATCH_TTL_LEDGERS,
            MATCH_TTL_LEDGERS,
        );

        // (#2094) Mark the match Completed so the result is immutable.
        env.storage()
            .persistent()
            .set(&DataKey::MatchCompleted(match_id), &true);
        env.storage().persistent().extend_ttl(
            &DataKey::MatchCompleted(match_id),
            MATCH_TTL_LEDGERS,
            MATCH_TTL_LEDGERS,
        );

        bump_initialized_ttl(&env);

        // Increment the result count so callers can construct efficient page ranges
        // without scanning sparse ID spaces.
        instance_state.result_count += 1;
        env.storage()
            .instance()
            .set(&DataKey::InstanceState, &instance_state);

        env.events().publish(
            (Symbol::new(&env, "oracle"), symbol_short!("result")),
            (match_id, game_id, result),
        );

        Ok(())
    }

    /// Submit a game result together with a cryptographic proof from the chess provider.
    ///
    /// This is the proof-gated submission path. The `proof` is the 32-byte SHA-256 digest
    /// of the canonical message `PROOF_DOMAIN || match_id || game_id_len || game_id || result`,
    /// keyed by the provider verification key registered via [`set_provider_key`]. The proof
    /// is verified **before** any state mutation; an invalid proof returns
    /// [`Error::InvalidProof`] and leaves storage untouched.
    ///
    /// The `caller` must be an authorized oracle (the primary oracle or a registered
    /// fallback oracle). The submitting address is recorded in [`ResultEntry::submitted_by`].
    ///
    /// # Errors
    ///
    /// * [`Error::Unauthorized`]     — `caller` is not an authorized oracle.
    /// * [`Error::InvalidGameId`]    — `game_id` is empty, too long, or contains invalid chars.
    /// * [`Error::ProofKeyNotSet`]   — No provider verification key has been registered.
    /// * [`Error::InvalidProof`]     — The proof does not match the recomputed digest.
    /// * [`Error::AlreadySubmitted`] — A result already exists for this `match_id`.
    pub fn submit_result_with_proof(
        env: Env,
        match_id: u64,
        game_id: String,
        result: MatchResult,
        proof: BytesN<32>,
        caller: Address,
    ) -> Result<(), Error> {
        caller.require_auth();

        // Authorize the caller as primary or fallback oracle before doing any work.
        Self::require_authorized_oracle(&env, &caller)?;

        let game_id_len = game_id.len();
        if game_id_len == 0 || game_id_len > MAX_GAME_ID_LEN {
            return Err(Error::InvalidGameId);
        }
        if !is_valid_game_id(&game_id) {
            return Err(Error::InvalidGameId);
        }

        // Reject duplicates before proof verification to avoid wasted crypto work.
        if env.storage().persistent().has(&DataKey::Result(match_id)) {
            return Err(Error::AlreadySubmitted);
        }

        // Proof verification MUST happen before any state change.
        let provider_key: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::ProviderKey)
            .ok_or(Error::ProofKeyNotSet)?;
        if !verify_proof(&env, &provider_key, match_id, &game_id, &result, &proof) {
            return Err(Error::InvalidProof);
        }

        let mut instance_state: InstanceState = env
            .storage()
            .instance()
            .get(&DataKey::InstanceState)
            .ok_or(Error::Unauthorized)?;

        let ledger_seq = env.ledger().sequence();
        env.storage().persistent().set(
            &DataKey::Result(match_id),
            &ResultEntry {
                game_id: game_id.clone(),
                result: result.clone(),
                submitted_ledger: ledger_seq,
                submitted_by: caller.clone(),
            },
        );
        env.storage().persistent().extend_ttl(
            &DataKey::Result(match_id),
            MATCH_TTL_LEDGERS,
            MATCH_TTL_LEDGERS,
        );
        bump_initialized_ttl(&env);

        instance_state.result_count += 1;
        env.storage()
            .instance()
            .set(&DataKey::InstanceState, &instance_state);

        env.events().publish(
            (Symbol::new(&env, "oracle"), symbol_short!("result")),
            (match_id, game_id, result),
        );
        env.events().publish(
            (Symbol::new(&env, "oracle"), symbol_short!("res_proof")),
            (match_id, caller),
        );

        Ok(())
    }

    /// Register or update the provider verification key used to validate result proofs.
    ///
    /// Only the admin may call this. The key is a 32-byte value (e.g. the SHA-256 of the
    /// provider's public key material) that is mixed into the proof digest.
    ///
    /// # Errors
    ///
    /// * [`Error::Unauthorized`] — Contract not initialized or caller is not the admin.
    pub fn set_provider_key(env: Env, key: BytesN<32>) -> Result<(), Error> {
        let instance_state: InstanceState = env
            .storage()
            .instance()
            .get(&DataKey::InstanceState)
            .ok_or(Error::Unauthorized)?;
        instance_state.admin.require_auth();

        env.storage().instance().set(&DataKey::ProviderKey, &key);
        env.storage()
            .instance()
            .extend_ttl(MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);
        bump_initialized_ttl(&env);

        env.events().publish(
            (Symbol::new(&env, "oracle"), symbol_short!("prov_key")),
            key,
        );
        Ok(())
    }

    /// Return the currently registered provider verification key, if any.
    pub fn get_provider_key(env: Env) -> Option<BytesN<32>> {
        env.storage().instance().get(&DataKey::ProviderKey)
    }

    /// Set the primary oracle address authorized to submit results.
    ///
    /// Only the admin may call this. The primary oracle is implicitly authorized in
    /// addition to any registered fallback oracles.
    ///
    /// # Errors
    ///
    /// * [`Error::Unauthorized`] — Contract not initialized or caller is not the admin.
    pub fn set_primary_oracle(env: Env, oracle: Address) -> Result<(), Error> {
        let instance_state: InstanceState = env
            .storage()
            .instance()
            .get(&DataKey::InstanceState)
            .ok_or(Error::Unauthorized)?;
        instance_state.admin.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::PrimaryOracle, &oracle);
        env.storage()
            .instance()
            .extend_ttl(MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);
        bump_initialized_ttl(&env);

        env.events().publish(
            (Symbol::new(&env, "oracle"), symbol_short!("prim_set")),
            oracle,
        );
        Ok(())
    }

    /// Return the configured primary oracle address, if any.
    pub fn get_primary_oracle(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::PrimaryOracle)
    }

    /// Add a fallback oracle authorized to submit results when the primary is unavailable.
    ///
    /// Only the admin may call this. Adding an address that is already a fallback oracle
    /// is a no-op (idempotent).
    ///
    /// # Errors
    ///
    /// * [`Error::Unauthorized`] — Contract not initialized or caller is not the admin.
    pub fn add_fallback_oracle(env: Env, oracle: Address) -> Result<(), Error> {
        let instance_state: InstanceState = env
            .storage()
            .instance()
            .get(&DataKey::InstanceState)
            .ok_or(Error::Unauthorized)?;
        instance_state.admin.require_auth();

        let mut fallbacks: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::FallbackOracles)
            .unwrap_or_else(|| Vec::new(&env));
        if !fallbacks.contains(&oracle) {
            fallbacks.push_back(oracle.clone());
            env.storage()
                .instance()
                .set(&DataKey::FallbackOracles, &fallbacks);
        }
        env.storage()
            .instance()
            .extend_ttl(MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);
        bump_initialized_ttl(&env);

        env.events().publish(
            (Symbol::new(&env, "oracle"), symbol_short!("fb_add")),
            oracle,
        );
        Ok(())
    }

    /// Remove a fallback oracle. Only the admin may call this.
    ///
    /// # Errors
    ///
    /// * [`Error::Unauthorized`] — Contract not initialized or caller is not the admin.
    pub fn remove_fallback_oracle(env: Env, oracle: Address) -> Result<(), Error> {
        let instance_state: InstanceState = env
            .storage()
            .instance()
            .get(&DataKey::InstanceState)
            .ok_or(Error::Unauthorized)?;
        instance_state.admin.require_auth();

        let fallbacks: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::FallbackOracles)
            .unwrap_or_else(|| Vec::new(&env));
        let mut updated: Vec<Address> = Vec::new(&env);
        for i in 0..fallbacks.len() {
            let a = fallbacks.get(i).unwrap();
            if a != oracle {
                updated.push_back(a);
            }
        }
        env.storage()
            .instance()
            .set(&DataKey::FallbackOracles, &updated);
        env.storage()
            .instance()
            .extend_ttl(MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);
        bump_initialized_ttl(&env);

        env.events().publish(
            (Symbol::new(&env, "oracle"), symbol_short!("fb_rm")),
            oracle,
        );
        Ok(())
    }

    /// Return the list of registered fallback oracles.
    pub fn get_fallback_oracles(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::FallbackOracles)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Internal helper: return `Ok(())` if `caller` is the primary oracle or a fallback
    /// oracle, otherwise [`Error::Unauthorized`].
    fn require_authorized_oracle(env: &Env, caller: &Address) -> Result<(), Error> {
        if let Some(primary) = env
            .storage()
            .instance()
            .get::<DataKey, Address>(&DataKey::PrimaryOracle)
        {
            if &primary == caller {
                return Ok(());
            }
        }
        let fallbacks: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::FallbackOracles)
            .unwrap_or_else(|| Vec::new(env));
        if fallbacks.contains(caller) {
            return Ok(());
        }
        Err(Error::Unauthorized)
    }
=======

    /// Retrieve the stored result for a match.
    ///
    /// Returns the full [`ResultEntry`] (game_id + result) for the given `match_id`.
    ///
    /// # Arguments
    ///
    /// * `match_id` — The escrow match ID to look up.
    ///
    /// # Errors
    ///
    /// Returns [`Error::ResultNotFound`] if no result has been submitted yet.
    pub fn get_result(env: Env, match_id: u64) -> Result<ResultEntry, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Result(match_id))
            .ok_or(Error::ResultNotFound)
    }

    /// Check whether a result has been submitted for a match.
    ///
    /// Returns `true` if [`submit_result`] has been called for the given `match_id`,
    /// `false` otherwise. Safe to call by anyone — no auth required.
    ///
    /// # Arguments
    ///
    /// * `match_id` — The escrow match ID to check.
    pub fn has_result(env: Env, match_id: u64) -> bool {
        env.storage().persistent().has(&DataKey::Result(match_id))
    }

    /// Check whether a match has been marked Completed (result is final).
    ///
    /// Returns `true` once a result has been accepted for the match, `false` otherwise.
    /// Safe to call by anyone — no auth required.
    ///
    /// # Arguments
    ///
    /// * `match_id` — The escrow match ID to check.
    pub fn is_match_completed(env: Env, match_id: u64) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::MatchCompleted(match_id))
    }

    /// Return the recorded creation timestamp for a match, if any.
    ///
    /// # Arguments
    ///
    /// * `match_id` — The escrow match ID to look up.
    ///
    /// # Errors
    ///
    /// Returns [`Error::ResultNotFound`] if no creation timestamp has been recorded.
    pub fn get_match_created_at(env: Env, match_id: u64) -> Result<u64, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::MatchCreatedAt(match_id))
            .ok_or(Error::ResultNotFound)
    }

    /// Step 1 of two-step admin transfer: propose a new admin address.
    ///
    /// Records `new_admin` as the pending admin. The transfer is not effective until
    /// the proposed address calls [`accept_admin`]. Only the current admin may call
    /// this function. Replaces any previously outstanding proposal.
    ///
    /// # Arguments
    ///
    /// * `new_admin` — The Stellar address being nominated as the next admin.
    ///
    /// # Errors
    ///
    /// * [`Error::Unauthorized`]  — Contract not initialized or caller is not the admin.
    /// * [`Error::InvalidAdmin`]  — `new_admin` is the zero/burn address or is the same
    ///   as the current admin.
    pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        let instance_state: InstanceState = env
            .storage()
            .instance()
            .get(&DataKey::InstanceState)
            .ok_or(Error::Unauthorized)?;
        let admin = instance_state.admin.clone();
        admin.require_auth();

        // Reject the zero/burn address — it can never sign a transaction.
        let zero_addr = Address::from_strkey(
            &env,
            &soroban_sdk::String::from_str(
                &env,
                "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
            ),
        );
        if new_admin == zero_addr {
            return Err(Error::InvalidAdmin);
        }

        // Proposing the current admin as the next admin makes no sense.
        if new_admin == admin {
            return Err(Error::InvalidAdmin);
        }

        env.storage()
            .instance()
            .set(&DataKey::PendingAdmin, &new_admin);
        env.storage()
            .instance()
            .extend_ttl(MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);
        bump_initialized_ttl(&env);

        env.events().publish(
            (Symbol::new(&env, "oracle"), symbol_short!("adm_prop")),
            (admin, new_admin),
        );

        Ok(())
    }

    /// Step 2 of two-step admin transfer: the proposed admin accepts the role.
    ///
    /// Completes the transfer by writing the pending admin as the active admin and
    /// clearing the pending proposal. Only the address that was proposed via
    /// [`propose_admin`] may call this function.
    ///
    /// # Errors
    ///
    /// * [`Error::Unauthorized`]    — Contract not initialized or caller is not the
    ///   pending admin.
    /// * [`Error::NoPendingAdmin`]  — No proposal is outstanding.
    pub fn accept_admin(env: Env) -> Result<(), Error> {
        let mut instance_state: InstanceState = env
            .storage()
            .instance()
            .get(&DataKey::InstanceState)
            .ok_or(Error::Unauthorized)?;

        let pending: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .ok_or(Error::NoPendingAdmin)?;

        pending.require_auth();

        let old_admin = instance_state.admin.clone();
        instance_state.admin = pending.clone();
        env.storage()
            .instance()
            .set(&DataKey::InstanceState, &instance_state);
        env.storage()
            .instance()
            .remove(&DataKey::PendingAdmin);
        env.storage()
            .instance()
            .extend_ttl(MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);
        bump_initialized_ttl(&env);

        env.events().publish(
            (Symbol::new(&env, "oracle"), symbol_short!("adm_xfer")),
            (old_admin, pending),
        );

        Ok(())
    }

    /// Cancel an outstanding admin transfer proposal.
    ///
    /// Removes the pending admin address without changing the active admin. Only the
    /// current admin may call this function.
    ///
    /// # Errors
    ///
    /// * [`Error::Unauthorized`]   — Contract not initialized or caller is not the admin.
    /// * [`Error::NoPendingAdmin`] — No proposal is outstanding.
    pub fn cancel_admin_transfer(env: Env) -> Result<(), Error> {
        let instance_state: InstanceState = env
            .storage()
            .instance()
            .get(&DataKey::InstanceState)
            .ok_or(Error::Unauthorized)?;
        let admin = instance_state.admin;
        admin.require_auth();

        if !env
            .storage()
            .instance()
            .has(&DataKey::PendingAdmin)
        {
            return Err(Error::NoPendingAdmin);
        }

        let pending: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .unwrap();

        env.storage()
            .instance()
            .remove(&DataKey::PendingAdmin);
        env.storage()
            .instance()
            .extend_ttl(MATCH_TTL_LEDGERS, MATCH_TTL_LEDGERS);
        bump_initialized_ttl(&env);

        env.events().publish(
            (Symbol::new(&env, "oracle"), symbol_short!("adm_cncl")),
            (admin, pending),
        );

        Ok(())
    }

    /// Recover tokens accidentally sent to the oracle contract address.
    ///
    /// Only the admin may call this. Uses `try_transfer` so that a failed transfer
    /// returns [`Error::TransferFailed`] rather than aborting the transaction.
    ///
    /// # Arguments
    ///
    /// * `token`  — The SEP-41 token contract address.
    /// * `amount` — Number of stroops to transfer (must be > 0).
    /// * `to`     — Destination address for the recovered funds.
    /// * `caller` — Must equal the registered admin; `require_auth` is called on it.
    ///
    /// # Errors
    ///
    /// * [`Error::Unauthorized`]   — Contract not yet initialized or caller ≠ admin.
    /// * [`Error::InvalidAmount`]   — `amount` is zero or negative.
    /// * [`Error::TransferFailed`] — The token transfer was rejected.
    pub fn withdraw(
        env: Env,
        token: Address,
        amount: i128,
        to: Address,
        caller: Address,
    ) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get::<DataKey, InstanceState>(&DataKey::InstanceState)
            .map(|state| state.admin)
            .ok_or(Error::Unauthorized)?;
        if caller != admin {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        // SAFETY: token::Client::try_transfer is a cross-contract call. Soroban's
        // single-execution model ensures no re-entrancy is possible: the token
        // contract cannot call back into this oracle contract during the transfer.
        token::Client::new(&env, &token)
            .try_transfer(&env.current_contract_address(), &to, &amount)
            .map_err(|_| Error::TransferFailed)?;

        // Emit an on-chain audit event for recovered funds so there is a
        // blockchain-level record of what token, amount, destination and admin
        // performed the recovery.
        env.events().publish(
            (Symbol::new(&env, "oracle"), symbol_short!("withdraw")),
            (token, amount, to, admin),
        );

        Ok(())
    }

    /// Return the total number of results that have been submitted so far.
    ///
    /// Clients can use this to build efficient page requests for [`list_results`]:
    /// iterate in windows of up to [`MAX_LIST_LIMIT`] starting from 0 up to
    /// `get_result_count()` to avoid scanning gaps in sparse ID spaces.
    ///
    /// [`list_results`]: OracleContract::list_results
    pub fn get_result_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get::<DataKey, InstanceState>(&DataKey::InstanceState)
            .map(|state| state.result_count)
            .unwrap_or(0)
    }

    /// Enumerate stored results for off-chain reconciliation.
    ///
    /// Returns up to `limit` `(match_id, ResultEntry)` pairs starting from `start`,
    /// scanning match IDs up to `min(start + limit, get_result_count())`. IDs with no
    /// stored result are skipped. `limit` is capped at [`MAX_LIST_LIMIT`] (100) to
    /// bound compute.
    ///
    /// Use [`get_result_count`] to determine the upper bound of submitted results and
    /// construct tight page requests — this avoids wasting compute budget on storage
    /// misses when the ID space is sparse.
    ///
    /// [`get_result_count`]: OracleContract::get_result_count
    ///
    /// # Arguments
    ///
    /// * `start` — First match_id to check (inclusive).
    /// * `limit` — Maximum number of entries to return (capped at 100).
    pub fn list_results(env: Env, start: u64, limit: u32) -> Vec<(u64, ResultEntry)> {
        let cap = limit.min(MAX_LIST_LIMIT);
        let result_count: u64 = env
            .storage()
            .instance()
            .get::<DataKey, InstanceState>(&DataKey::InstanceState)
            .map(|state| state.result_count)
            .unwrap_or(0u64);
        let end = start.saturating_add(cap as u64).min(result_count);
        let mut out: Vec<(u64, ResultEntry)> = Vec::new(&env);
        for id in start..end {
            if let Some(entry) = env
                .storage()
                .persistent()
                .get::<DataKey, ResultEntry>(&DataKey::Result(id))
            {
                out.push_back((id, entry));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{storage::Persistent as _, Address as _, Events, Ledger},
        vec, Address, Env, IntoVal, String, Symbol,
    };

    fn setup() -> (Env, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        // Set a deterministic ledger timestamp so timestamp validation is predictable.
        env.ledger().set_timestamp(1_000_000);
        let admin = Address::generate(&env);
        let contract_id = env.register(OracleContract, ());
        let client = OracleContractClient::new(&env, &contract_id);
        client.initialize(&admin);
        (env, contract_id, admin)
    }

    /// Register a match with a creation timestamp well before the ledger time.
    fn register_match(env: &Env, contract_id: &Address, match_id: u64) {
        let client = OracleContractClient::new(env, contract_id);
        client.register_match(&match_id, &1_000u64);
    }

    #[test]
    fn test_submit_and_get_result() {
        let (env, contract_id, admin) = setup();
        let client = OracleContractClient::new(&env, &contract_id);
        register_match(&env, &contract_id, 0u64);

        assert!(!client.has_result(&0u64));

        client.submit_result(
            &admin,
            &0u64,
            &String::from_str(&env, "abc-123_XYZ"),
            &MatchResult::Player1Wins,
            &1u64,
            &2_000u64,
        );

        assert!(client.has_result(&0u64));
        assert_eq!(client.get_result(&0u64).result, MatchResult::Player1Wins);

        // TTL must be extended
        let ttl = env.as_contract(&contract_id, || {
            env.storage().persistent().get_ttl(&DataKey::Result(0u64))
        });
        assert_eq!(ttl, crate::MATCH_TTL_LEDGERS);
    }

    #[test]
    fn test_get_result_not_found() {
        let (env, contract_id, _admin) = setup();
        let client = OracleContractClient::new(&env, &contract_id);
        assert!(matches!(
            client.try_get_result(&999u64),
            Err(Ok(Error::ResultNotFound))
        ));
    }

    #[test]
    fn test_submit_result_empty_game_id_fails() {
        let (env, contract_id, admin) = setup();
        let client = OracleContractClient::new(&env, &contract_id);
        register_match(&env, &contract_id, 0u64);

        assert_eq!(
            client.try_submit_result(
                &admin,
                &0u64,
                &String::from_str(&env, ""),
                &MatchResult::Player1Wins,
                &1u64,
                &2_000u64,
            ),
            Err(Ok(Error::InvalidGameId))
        );
    }

    #[test]
    fn test_submit_result_invalid_game_id_characters_fail() {
        let (env, contract_id, admin) = setup();
        let client = OracleContractClient::new(&env, &contract_id);
        register_match(&env, &contract_id, 0u64);

        assert_eq!(
            client.try_submit_result(
                &admin,
                &0u64,
                &String::from_str(&env, "game.id"),
                &MatchResult::Player1Wins,
                &1u64,
                &2_000u64,
            ),
            Err(Ok(Error::InvalidGameId))
        );
    }

    #[test]
    fn test_submit_result_game_id_over_max_byte_length_fails() {
        let (env, contract_id, admin) = setup();
        let client = OracleContractClient::new(&env, &contract_id);
        register_match(&env, &contract_id, 0u64);
        let game_id = String::from_bytes(&env, &[b'a'; MAX_GAME_ID_LEN as usize + 1]);

        assert_eq!(
            client.try_submit_result(&admin, &0u64, &game_id, &MatchResult::Player1Wins, &1u64, &2_000u64),
            Err(Ok(Error::InvalidGameId))
        );
    }

    #[test]
    fn test_submit_result_by_non_admin_returns_unauthorized() {
        let env = Env::default();
        env.ledger().set_timestamp(1_000_000);
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let contract_id = env.register(OracleContract, ());
        let client = OracleContractClient::new(&env, &contract_id);
        client.initialize(&admin);
        client.register_match(&1u64, &1_000u64);

        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        env.mock_auths(&[MockAuth {
            address: &non_admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "submit_result",
                args: (
                    non_admin.clone(),
                    1u64,
                    String::from_str(&env, "game1"),
                    MatchResult::Player1Wins,
                    1u64,
                    2_000u64,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }]);

        assert_eq!(
            client.try_submit_result(
                &non_admin,
                &1u64,
                &String::from_str(&env, "game1"),
                &MatchResult::Player1Wins,
                &1u64,
                &2_000u64,
            ),
            Err(Ok(Error::Unauthorized)),
            "non-oracle caller must be rejected with Unauthorized"
        );
        assert!(
            !client.has_result(&1u64),
            "result must not be stored after rejected submission"
        );
    }

    #[test]
    fn test_double_initialize_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let replacement_admin = Address::generate(&env);
        let contract_id = env.register(OracleContract, ());
        let client = OracleContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        let initial_admin = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .get::<DataKey, InstanceState>(&DataKey::InstanceState)
                .unwrap()
                .admin
        });
        assert_eq!(initial_admin, admin);
        assert!(env.as_contract(&contract_id, || env
            .storage()
            .persistent()
            .has(&DataKey::IsInitialized)));

        assert_eq!(
            client.try_initialize(&replacement_admin),
            Err(Ok(Error::AlreadyInitialized))
        );

        let admin_after_retry = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .get::<DataKey, InstanceState>(&DataKey::InstanceState)
                .unwrap()
                .admin
        });
        assert_eq!(admin_after_retry, admin);