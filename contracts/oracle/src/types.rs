use soroban_sdk::{contracttype, Address, Bytes, BytesN, String};

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
    pub submitted_by: Address,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct ResultProof {
    pub provider: String,
    pub signature: Bytes,
    pub payload_hash: BytesN<32>,
}

#[contracttype]
pub enum DataKey {
    InstanceState,
    IsInitialized,
    Result(u64), // keyed by match_id
    PendingAdmin, // proposed new admin address awaiting acceptance
    ProviderKey(String), // provider verification key
    PrimaryOracle,
    FallbackOracles,
}