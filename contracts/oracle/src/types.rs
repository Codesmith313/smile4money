use soroban_sdk::{contracttype, Address, String};

#[contracttype]
#[derive(Clone, Debug)]
pub struct InstanceState {
    pub admin: Address,
    pub result_count: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MatchResult {
    Player1Wins,
    Player2Wins,
    Draw,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct ResultEntry {
    pub game_id: String,
    pub result: MatchResult,
    pub submitted_ledger: u32,
    pub nonce: u64,
    pub submitted_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MatchStatus {
    Pending,
    Completed,
}

#[contracttype]
pub enum DataKey {
    InstanceState,
    IsInitialized,
    Result(u64), // keyed by match_id
    PendingAdmin, // proposed new admin address awaiting acceptance
    MatchCreatedAt(u64), // keyed by match_id, creation timestamp
    Nonce(u64), // keyed by match_id, last accepted nonce for replay protection
    UsedNonce(Address, u64), // keyed by submitter and nonce, replay protection
    MatchStatus(u64), // keyed by match_id, finality flag
}