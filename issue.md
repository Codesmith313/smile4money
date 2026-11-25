# smile4money — Issue Tracker

This tracker contains 125 proposed work items. Each issue identifies an owning area, priority, problem, and acceptance criteria. The entries are intended to describe distinct work from the previously tracked issue set; verify current upstream status before opening them as GitHub issues.

Priority guide: **Critical** blocks safe operation; **High** affects correctness, funds, or a core workflow; **Medium** is important product or reliability work; **Low** is a contained improvement.

---

## Tournament Bracket Contract

### Issue #1 — Require the tournament creator to authorize initialization
**Area:** `contracts/tournament-bracket/src/lib.rs`  
**Priority:** Critical  
**Type:** Authorization / Security

**Problem:** Initialization establishes the tournament administrator and trusted dependencies. If the initial call does not prove the intended creator's authorization, an unrelated account can seize control of a newly deployed instance.

**Acceptance criteria:** Initialization requires authorization from the designated admin; tests prove an unauthorized caller cannot initialize and the authorized caller can initialize only once.

### Issue #2 — Persist a unique game identifier for each bracket node
**Area:** `contracts/tournament-bracket/src/lib.rs`, `contracts/tournament-bracket/src/types.rs`  
**Priority:** High  
**Type:** Data Integrity

**Problem:** A node needs a durable association to the external game whose result advances its winner. Without a stored game identifier, later submissions cannot reliably prove they refer to that node's game.

**Acceptance criteria:** Each playable node stores its game ID; duplicate IDs within a tournament and attempts to replace a finalized node's ID are rejected with typed errors.

### Issue #3 — Add a review window before accepting a bracket result as final
**Area:** `contracts/tournament-bracket/src/lib.rs`  
**Priority:** High  
**Type:** Product / Dispute Handling

**Problem:** Immediately advancing a player on the first reported result leaves no defined process for correcting a verified-but-contested outcome.

**Acceptance criteria:** A result enters a reviewable state with a configurable or documented deadline; only an authorized reviewer can amend it during that window, and advancement is blocked until the result becomes final.

### Issue #4 — Separate registration deadlines from tournament completion deadlines
**Area:** `contracts/tournament-bracket/src/lib.rs`, `contracts/tournament-bracket/src/types.rs`  
**Priority:** Medium  
**Type:** Lifecycle Design

**Problem:** A single deadline can either stop late-joining registration too early or give activated tournaments insufficient time to finish.

**Acceptance criteria:** Registration close and tournament completion have distinct stored deadlines; tests cover activation near registration close and completion after registration has closed.

### Issue #5 — Define deterministic handling for drawn or abandoned bracket games
**Area:** `contracts/tournament-bracket/src/lib.rs`, `contracts/tournament-bracket/src/types.rs`  
**Priority:** High  
**Type:** Lifecycle / Funds

**Problem:** A bracket node that ends in a draw, cancellation, or unplayed game needs an explicit outcome; otherwise the tournament can remain permanently blocked.

**Acceptance criteria:** The contract exposes documented, authorized paths for each supported non-win outcome, with tests proving the node can progress or be refunded without assigning an arbitrary winner.

### Issue #6 — Add a tournament emergency mode that preserves participant exits
**Area:** `contracts/tournament-bracket/src/lib.rs`  
**Priority:** High  
**Type:** Resilience / Funds

**Problem:** Operators need a response to an incident affecting tournament progression, but a blanket pause could also trap participants who need an allowed exit.

**Acceptance criteria:** An authorized pause blocks new tournament progression while documented cancellation or refund paths remain available; tests cover the exact allowed operations while paused.

### Issue #7 — Support safe administrator handoff for tournament deployments
**Area:** `contracts/tournament-bracket/src/lib.rs`  
**Priority:** Medium  
**Type:** Administration

**Problem:** A permanently fixed administrator address makes operations brittle when a key is rotated or its owner leaves.

**Acceptance criteria:** Add a two-step propose-and-accept handoff, emit auditable events, and test acceptance by the proposed address plus rejection of unauthorized or stale proposals.

### Issue #8 — Bind tournament result submissions to a specific tournament and node
**Area:** `contracts/tournament-bracket/src/lib.rs`, `apps/backend/src`  
**Priority:** High  
**Type:** Cross-Contract Integration

**Problem:** Result relaying must identify the exact tournament and bracket node, not merely a game or match, or identical identifiers across tournaments can update the wrong bracket.

**Acceptance criteria:** The submission interface includes tournament and node identifiers; integration tests prove a result for one tournament cannot mutate another tournament's node.

### Issue #9 — Expose bracket rounds in a compact read model
**Area:** `contracts/tournament-bracket/src/lib.rs`  
**Priority:** Medium  
**Type:** API Design

**Problem:** Clients that need to render a bracket should not have to fetch every node individually and reconstruct round membership from implementation details.

**Acceptance criteria:** Add a bounded read method returning a documented round slice with stable node identifiers and state; test empty, partial, and completed rounds.

### Issue #10 — Prevent a participant from occupying both sides of a bracket match
**Area:** `contracts/tournament-bracket/src/lib.rs`  
**Priority:** High  
**Type:** Tournament Integrity

**Problem:** Advancement logic must preserve the bracket invariant that two sides of a playable node represent distinct participants.

**Acceptance criteria:** Bracket construction and advancement reject identical participant addresses in both slots; property tests exercise byes and all supported bracket sizes.

### Issue #11 — Make byes explicit in bracket state rather than inferred from empty slots
**Area:** `contracts/tournament-bracket/src/types.rs`, `contracts/tournament-bracket/src/lib.rs`  
**Priority:** Medium  
**Type:** Data Model

**Problem:** Treating an empty participant slot as a bye conflates a valid tournament state with incomplete registration or corrupted storage.

**Acceptance criteria:** Represent byes explicitly in the node model and define how they advance; tests distinguish a bye from an unfilled or malformed node.

### Issue #12 — Reject tournament configuration that cannot form a valid bracket
**Area:** `contracts/tournament-bracket/src/lib.rs`  
**Priority:** High  
**Type:** Input Validation

**Problem:** Invalid entrant counts or bracket dimensions can create unreachable nodes and permanently stalled rounds.

**Acceptance criteria:** Validate supported entrant counts and computed node totals before storing a tournament; boundary tests cover minimum, maximum, and unsupported sizes.

### Issue #13 — Make tournament enrollment close atomically at the deadline
**Area:** `contracts/tournament-bracket/src/lib.rs`  
**Priority:** High  
**Type:** Concurrency / Lifecycle

**Problem:** Enrollment and activation need a single ledger-based rule at the boundary so transaction ordering cannot admit entrants after the bracket is frozen.

**Acceptance criteria:** Enrollment checks the current ledger against the stored close ledger; tests at one ledger before, exactly at, and one ledger after the boundary document the policy.

### Issue #14 — Record tournament prize allocation rules at creation time
**Area:** `contracts/tournament-bracket/src/types.rs`, `contracts/tournament-bracket/src/lib.rs`  
**Priority:** High  
**Type:** Funds / Product Rules

**Problem:** Participants need immutable, inspectable payout terms before joining; deriving prize allocation from mutable off-chain configuration can produce inconsistent expectations.

**Acceptance criteria:** Store the prize schedule and token with the tournament; reject schedules whose total exceeds deposited funds and expose the final schedule through a read method.

### Issue #15 — Define refunds when a tournament fails to reach its minimum field
**Area:** `contracts/tournament-bracket/src/lib.rs`  
**Priority:** High  
**Type:** Funds / Lifecycle

**Problem:** A tournament that never reaches its required number of entrants needs an explicit way to return entry funds instead of locking them indefinitely.

**Acceptance criteria:** Store a minimum entrant requirement and provide a post-deadline refund path when it is unmet; test that each eligible entrant can claim at most once.

### Issue #16 — Emit a stable event for each bracket advancement
**Area:** `contracts/tournament-bracket/src/lib.rs`  
**Priority:** Medium  
**Type:** Observability / Integration

**Problem:** Consumers need to discover which participant advanced from which node without polling and diffing the entire bracket.

**Acceptance criteria:** Publish a versioned event containing tournament ID, node ID, winner, and resulting next node; tests verify event fields for normal advancement and byes.

### Issue #17 — Guard tournament payout against partial-transfer state changes
**Area:** `contracts/tournament-bracket/src/lib.rs`  
**Priority:** Critical  
**Type:** Funds / Atomicity

**Problem:** Multi-recipient payouts must not leave the tournament marked complete if one transfer fails after earlier transfer attempts.

**Acceptance criteria:** State changes and transfers execute atomically or use a retryable claims model; fault-injection tests prove no recipient is underpaid or paid twice.

### Issue #18 — Add a resumable tournament settlement path for large prize lists
**Area:** `contracts/tournament-bracket/src/lib.rs`  
**Priority:** Medium  
**Type:** Scalability

**Problem:** Paying every prize recipient in one invocation can exceed Soroban resource limits as tournament size grows.

**Acceptance criteria:** Settlement records the allocation once and lets each recipient claim independently or processes bounded batches; resource tests cover the maximum supported field.

### Issue #19 — Include an explicit tournament version in stored state
**Area:** `contracts/tournament-bracket/src/types.rs`  
**Priority:** Medium  
**Type:** Upgrade Compatibility

**Problem:** Persisted tournament records need a detectable schema version before future contract upgrades change field layout or meaning.

**Acceptance criteria:** New records contain a version field and decoding has a tested migration or rejection policy for older versions.

### Issue #20 — Define an archival policy for completed tournament records
**Area:** `contracts/tournament-bracket/src/lib.rs`, `contracts/tournament-bracket/README.md`  
**Priority:** Low  
**Type:** Storage Lifecycle

**Problem:** Completed tournament state has no explicit retention and archival contract, leaving clients unsure which records remain queryable over time.

**Acceptance criteria:** Document retention guarantees and provide a bounded archival or permanent-record policy; tests verify archival cannot alter settlement facts.

---

## Leaderboard Contract

### Issue #21 — Make result recording idempotent by settlement identifier
**Area:** `contracts/leaderboard/src/lib.rs`  
**Priority:** High  
**Type:** Data Integrity

**Problem:** A result reporter can submit the same completed match more than once and inflate player statistics if the contract has no durable processed-settlement key.

**Acceptance criteria:** Require a stable escrow settlement ID and record it once; repeated submissions return a typed duplicate result without changing any statistic.

### Issue #22 — Keep earnings separated by asset denomination
**Area:** `contracts/leaderboard/src/lib.rs`, `contracts/leaderboard/src/types.rs`  
**Priority:** High  
**Type:** Accounting

**Problem:** Summing token smallest-units across assets makes the displayed total economically meaningless when assets have different decimals or exchange values.

**Acceptance criteria:** Store per-asset totals or a documented conversion basis, and expose denomination with every amount; tests combine two assets with different decimals.

### Issue #23 — Represent an unset asset separately from a player's first asset
**Area:** `contracts/leaderboard/src/lib.rs`, `contracts/leaderboard/src/types.rs`  
**Priority:** High  
**Type:** Data Model

**Problem:** A newly requested player record should not fabricate an asset address as a default value, since clients may interpret that address as a valid earning denomination.

**Acceptance criteria:** Use an optional asset or per-asset collection for empty records; tests show an unseen player returns an unambiguous empty state.

### Issue #24 — Use checked arithmetic for leaderboard aggregates
**Area:** `contracts/leaderboard/src/lib.rs`, `contracts/leaderboard/src/types.rs`  
**Priority:** High  
**Type:** Numeric Safety

**Problem:** Wins, losses, draws, and token earnings can overflow fixed-width integers over the contract lifetime and trap result recording.

**Acceptance criteria:** All aggregate updates use checked arithmetic and return a documented error without partially updating any player record.

### Issue #25 — Replace full-roster ranking work with a bounded ranking strategy
**Area:** `contracts/leaderboard/src/lib.rs`  
**Priority:** High  
**Type:** Scalability / Soroban Budget

**Problem:** Loading and sorting the entire player roster in one invocation makes ranking cost grow with all historical participants.

**Acceptance criteria:** Adopt a storage/index design with bounded read work for requested ranks; resource-budget tests demonstrate limits at the declared maximum population.

### Issue #26 — Refresh leaderboard authorization state while the contract is active
**Area:** `contracts/leaderboard/src/lib.rs`  
**Priority:** High  
**Type:** Storage Lifecycle

**Problem:** Long-lived deployments can lose instance-level admin or reporter configuration even while result writes continue unless that storage lifetime is extended.

**Acceptance criteria:** Mutating entry points extend the required instance TTL; tests advance ledger sequence and verify authorization remains available after normal writes.

### Issue #27 — Add a token-denominated rank view for each leaderboard asset
**Area:** `contracts/leaderboard/src/lib.rs`  
**Priority:** Medium  
**Type:** Ranking Semantics

**Problem:** A single cross-asset score cannot compare players fairly when recorded assets use different decimals or have different market values.

**Acceptance criteria:** Expose per-asset rankings without implying an exchange-rate conversion; tests verify separate orderings for two assets and document ties.

### Issue #28 — Validate asset contracts before accepting leaderboard amounts
**Area:** `contracts/leaderboard/src/lib.rs`  
**Priority:** High  
**Type:** Input Integrity

**Problem:** A trusted reporting address can still send malformed token identifiers or amounts that corrupt display and ranking data.

**Acceptance criteria:** Verify the asset is a valid contract address and amount is nonnegative under the API's defined semantics; invalid values do not write records.

### Issue #29 — Identify the changed reporter in source-management events
**Area:** `contracts/leaderboard/src/lib.rs`  
**Priority:** Low  
**Type:** Auditability

**Problem:** An event that only says reporter permissions changed cannot reconstruct which address was granted or revoked.

**Acceptance criteria:** Publish the affected reporter address and operation in a stable event; event tests cover grant and revoke.

### Issue #30 — Reject duplicate reporter grants explicitly
**Area:** `contracts/leaderboard/src/lib.rs`  
**Priority:** Low  
**Type:** API Consistency

**Problem:** Repeating an already-applied reporter grant can silently conceal caller mistakes and make transaction success appear to represent a new policy change.

**Acceptance criteria:** Return a documented no-op or duplicate error consistently; tests assert both return behavior and unchanged storage.

### Issue #31 — Define tie-breaking rules for equal leaderboard scores
**Area:** `contracts/leaderboard/src/lib.rs`, `apps/frontend/src/pages/Leaderboard.tsx`  
**Priority:** Medium  
**Type:** Ranking Semantics

**Problem:** Equal scores can reorder between queries, causing unstable ranks and confusing cursor-based consumers.

**Acceptance criteria:** Document and implement deterministic secondary ordering, such as wins then address bytes; tests verify repeatable order for equal primary scores.

### Issue #32 — Add a ranking snapshot identifier to multi-page reads
**Area:** `contracts/leaderboard/src/lib.rs`, `apps/frontend/src/pages/Leaderboard.tsx`  
**Priority:** Medium  
**Type:** Consistent Reads

**Problem:** A result arriving between page requests may shift the leaderboard and duplicate or omit players across the rendered page set.

**Acceptance criteria:** Provide a snapshot ledger or stable cursor token and tests that page retrieval remains consistent while a new result is recorded.

### Issue #33 — Separate lifetime totals from season-specific leaderboard records
**Area:** `contracts/leaderboard/src/types.rs`, `contracts/leaderboard/src/lib.rs`  
**Priority:** Medium  
**Type:** Product Feature

**Problem:** A single lifetime ranking cannot support time-bounded competitions without off-chain recomputation that may disagree with chain data.

**Acceptance criteria:** Add an explicit season identifier to reporting and reads; season reset or rollover cannot mutate prior season totals.

### Issue #34 — Allow a player to query their own full asset breakdown
**Area:** `contracts/leaderboard/src/lib.rs`, `apps/frontend/src/pages/Leaderboard.tsx`  
**Priority:** Medium  
**Type:** Read API

**Problem:** A single summary value does not let users audit which assets and settlements contributed to their rank.

**Acceptance criteria:** Expose a bounded per-player asset breakdown with documented units and test the response for multiple assets and no recorded results.

### Issue #35 — Define how refunded and reversed settlements affect statistics
**Area:** `contracts/leaderboard/src/lib.rs`, `contracts/escrow/src/lib.rs`  
**Priority:** High  
**Type:** Cross-Contract Accounting

**Problem:** Leaderboard records need a policy for a settlement later refunded, disputed, or corrected; otherwise chain state and rankings may diverge.

**Acceptance criteria:** Define immutable-final or compensating-entry semantics and test a correction path without deleting the original audit record.

### Issue #36 — Bound the size of per-player asset and season collections
**Area:** `contracts/leaderboard/src/types.rs`, `contracts/leaderboard/src/lib.rs`  
**Priority:** Medium  
**Type:** Resource Limits

**Problem:** Even if global ranking is bounded, unbounded per-player asset or season vectors can exceed serialization and instruction budgets.

**Acceptance criteria:** Set documented limits or use paged storage; tests cover the maximum and reject additions beyond it without partial writes.

### Issue #37 — Version leaderboard events for downstream indexers
**Area:** `contracts/leaderboard/src/lib.rs`  
**Priority:** Low  
**Type:** Integration Compatibility

**Problem:** Consumers have no explicit schema version when event payload semantics evolve, making an indexer unable to distinguish old and new formats.

**Acceptance criteria:** Include an event version or versioned topic and document backward-compatibility rules with event decoding tests.

---

## Contract Registry

### Issue #38 — Store a contract address alongside each registry name
**Area:** `contracts/contract-registry/src/lib.rs`, `docs/architecture.md`  
**Priority:** High  
**Type:** Registry API

**Problem:** A symbolic registration is not enough for a client to resolve the deployed contract if the record does not persist the corresponding contract address.

**Acceptance criteria:** Registration and update accept a contract address, reads return it with metadata, and redeployment tests verify clients resolve the replacement address.

### Issue #39 — Make registry enumeration return stable pages
**Area:** `contracts/contract-registry/src/lib.rs`  
**Priority:** Medium  
**Type:** Read API

**Problem:** A count plus lookup-by-name cannot discover all registered names, limiting bootstrap clients and audit tooling.

**Acceptance criteria:** Add a bounded enumeration API with deterministic ordering and tests for empty, partial, and final pages.

### Issue #40 — Preserve registration history when a contract is replaced
**Area:** `contracts/contract-registry/src/lib.rs`  
**Priority:** Medium  
**Type:** Auditability

**Problem:** Replacing a live address overwrites the information operators need to explain which deployment was active at a past ledger.

**Acceptance criteria:** Emit an event or retain a bounded version history containing prior address, replacement address, actor, and ledger; test the history order.

### Issue #41 — Define ownership semantics for registry records
**Area:** `contracts/contract-registry/src/lib.rs`  
**Priority:** Medium  
**Type:** Authorization Model

**Problem:** The contract should state whether record ownership belongs to the registry admin, initial registrant, or both; ambiguous ownership can prevent safe maintenance.

**Acceptance criteria:** Document a single policy and enforce it consistently across register, update, and deregister operations with a role matrix test.

### Issue #42 — Prevent registry clients from accepting stale deployment records
**Area:** `contracts/contract-registry/src/lib.rs`, `apps/frontend/src`  
**Priority:** High  
**Type:** Deployment Integrity

**Problem:** Clients need a way to distinguish an intentionally current deployment from a stale or superseded entry returned by cache or an older registry version.

**Acceptance criteria:** Add deployment revision or effective-ledger metadata and make the client validate the expected network and registry identity before using an address.

### Issue #43 — Add a read-only registry health and schema query
**Area:** `contracts/contract-registry/src/lib.rs`  
**Priority:** Low  
**Type:** Operations API

**Problem:** Deployment verification tools cannot cheaply establish whether the registry is initialized with the expected schema and administrator.

**Acceptance criteria:** Expose safe read-only metadata without secrets and cover initialized, uninitialized, and migrated states in tests.

### Issue #44 — Validate registry names against a canonical naming policy
**Area:** `contracts/contract-registry/src/lib.rs`, `contracts/contract-registry/README.md`  
**Priority:** Medium  
**Type:** Data Validation

**Problem:** Inconsistent names can create multiple registry entries for the same logical service and make client resolution dependent on spelling.

**Acceptance criteria:** Define allowed names and canonical case; reject aliases or normalize them deterministically with tests for invalid bytes and reserved names.

---

## Backend and Oracle Runtime

### Issue #45 — Submit verified outcomes to Soroban instead of returning a placeholder result
**Area:** `apps/backend/src/server.ts`, `apps/backend/src/services/oracle-submit.ts`  
**Priority:** Critical  
**Type:** End-to-End Integration

**Problem:** A verified game result is not useful to escrow unless the runtime constructs and submits the corresponding signed contract invocation.

**Acceptance criteria:** Configure the signer and contract clients, submit a verified settlement, and return the transaction hash and final chain status in an integration test against a local network.

### Issue #46 — Schedule monitoring when a match becomes eligible for oracle review
**Area:** `apps/backend/src/server.ts`, `apps/backend/src/services/polling.ts`  
**Priority:** High  
**Type:** Workflow Integration

**Problem:** Persisting a match does not ensure a worker will monitor its external game, so eligible matches can remain unsettled indefinitely.

**Acceptance criteria:** Define the activation event or reconciliation source, enqueue eligible matches exactly once, and test restart recovery from persisted active matches.

### Issue #47 — Preserve a completed game result until its chain submission is confirmed
**Area:** `apps/backend/src/services/polling.ts`, `apps/backend/src/services/oracle-submit.ts`  
**Priority:** Critical  
**Type:** Reliability / Funds

**Problem:** If a callback fails after a game is marked complete, removing its polling work can permanently lose the result needed to release escrow funds.

**Acceptance criteria:** Persist the result as pending settlement before acknowledging completion; retry through a durable state transition until confirmed or explicitly quarantined.

### Issue #48 — Reconcile uncertain transaction outcomes before retrying a settlement
**Area:** `apps/backend/src/services/oracle-submit.ts`  
**Priority:** High  
**Type:** Transaction Safety

**Problem:** A network timeout after submission does not reveal whether Soroban committed the transaction; blindly retrying can create confusing duplicate attempts.

**Acceptance criteria:** Persist the transaction hash and query its status before resubmission; tests simulate timeout-before-commit and timeout-after-commit.

### Issue #49 — Separate transient provider failures from invalid game data
**Area:** `apps/backend/src/fetchers/lichess.ts`, `apps/backend/src/fetchers/chessdotcom.ts`  
**Priority:** High  
**Type:** Error Classification

**Problem:** The worker needs different actions for rate limits, unavailable providers, malformed responses, and a genuinely nonexistent game.

**Acceptance criteria:** Define typed fetch outcomes and retry policies for each class; unit tests assert the correct retry, stop, or operator-review behavior.

### Issue #50 — Reject unrecognized Chess.com termination codes instead of guessing a draw
**Area:** `apps/backend/src/fetchers/chessdotcom.ts`  
**Priority:** Critical  
**Type:** Result Integrity

**Problem:** Mapping unknown provider labels to a draw can cause an incorrect payout when the upstream API adds or changes result codes.

**Acceptance criteria:** Use an exhaustive mapping for documented terminal outcomes; unknown values produce a non-settleable review result and a redacted diagnostic.

### Issue #51 — Reject provider payloads whose timestamps are internally inconsistent
**Area:** `apps/backend/src/fetchers`, `apps/backend/src/services/oracle-service.ts`
**Priority:** High  
**Type:** Evidence Validation

**Problem:** A result response with an end time earlier than its start time, a future completion time, or an impossible duration should not be accepted as settlement evidence.

**Acceptance criteria:** Validate timestamp ordering and allowed clock skew at the provider boundary; tests show malformed chronology is quarantined and never submitted.

### Issue #52 — Allow match identifier zero where the contract permits it
**Area:** `apps/backend/src/services/oracle-service.ts`, `apps/backend/src/store/match-store.ts`  
**Priority:** High  
**Type:** Boundary Compatibility

**Problem:** If the local store's first valid identifier is zero while API validation rejects zero, the first match cannot be verified.

**Acceptance criteria:** Align accepted ranges with the contract and store; tests exercise zero, one, maximum supported value, and invalid negative or non-integer input.

### Issue #53 — Align backend identifier validation with Soroban constraints
**Area:** `apps/backend/src/services/match-service.ts`, `contracts/escrow/src/lib.rs`  
**Priority:** High  
**Type:** Cross-Layer Validation

**Problem:** Accepting identifiers in the API that escrow cannot encode or accept creates orphan database records and non-settleable wagers.

**Acceptance criteria:** Share or mirror the contract's exact length and character rules; contract/API conformance tests use the same boundary cases.

### Issue #54 — Reject stake values that the escrow contract cannot accept before persistence
**Area:** `apps/backend/src/services/match-service.ts`, `contracts/escrow/src/constants.rs`  
**Priority:** High  
**Type:** Cross-Layer Validation

**Problem:** Persisting a match before checking all contract limits lets clients create records that can never be funded on-chain.

**Acceptance criteria:** Validate the contract's precise amount bounds and asset precision before writing; invalid requests leave no stored match.

### Issue #55 — Require cryptographic proof that a wallet controls its chess account
**Area:** `apps/backend/src/services/player-identity.ts`, `apps/backend/src/services/match-service.ts`  
**Priority:** High  
**Type:** Identity Verification

**Problem:** A stored username-to-wallet association is only trustworthy if the account holder proves control of both identities.

**Acceptance criteria:** Add a nonce-based signed linking flow with expiry and one-time consumption; tests reject replayed, expired, or wrong-wallet proofs.

### Issue #56 — Preserve the exact normalized evidence used for each settlement decision
**Area:** `apps/backend/src/services/oracle-service.ts`, `apps/backend/src/store`
**Priority:** High  
**Type:** Auditability

**Problem:** If the provider later changes or removes a game record, operators need to reproduce what the oracle actually evaluated without storing unnecessary raw personal data.

**Acceptance criteria:** Persist a sanitized canonical evidence record and parser version before submission; access is restricted and retention is documented.

### Issue #57 — Search Chess.com archives beyond a fixed recent-history window
**Area:** `apps/backend/src/fetchers/chessdotcom.ts`  
**Priority:** Medium  
**Type:** Provider Coverage

**Problem:** A valid wagered game may be older than the fetcher's finite archive scan and be incorrectly classified as missing.

**Acceptance criteria:** Use a direct lookup when available or bounded configurable archive traversal; test a match at the oldest supported range and a true not-found result.

### Issue #58 — Normalize provider timestamps and result enums at the fetcher boundary
**Area:** `apps/backend/src/fetchers`  
**Priority:** Medium  
**Type:** Integration Contract

**Problem:** Provider-specific timestamps and outcome spellings should not leak into settlement logic, where inconsistent formats can alter timeout or result decisions.

**Acceptance criteria:** Fetchers return one validated internal schema with UTC timestamps and explicit terminal outcomes; contract tests cover representative provider payloads.

### Issue #59 — Add an operator quarantine path for ambiguous provider evidence
**Area:** `apps/backend/src/services/oracle-service.ts`, `apps/backend/src/store`  
**Priority:** High  
**Type:** Human Review

**Problem:** Conflicting or incomplete provider data should not be silently retried forever or automatically settled.

**Acceptance criteria:** Persist a review-required state with reason and evidence references; expose an authenticated administrative workflow that cannot directly bypass on-chain authorization.

### Issue #60 — Persist provider response provenance for each settlement decision
**Area:** `apps/backend/src/services/oracle-service.ts`, `apps/backend/src/store`  
**Priority:** Medium  
**Type:** Auditability

**Problem:** After settlement, operators need to explain which provider response and parser version produced the submitted winner.

**Acceptance criteria:** Store provider name, fetch time, normalized outcome, and parser version without retaining unnecessary personal data; tests verify provenance follows the result lifecycle.

### Issue #61 — Add explicit backend schema migrations for SQLite stores
**Area:** `apps/backend/src/store`, `apps/backend/src`  
**Priority:** High  
**Type:** Data Migration

**Problem:** Persistent queue, match, and rate-limit tables need a controlled upgrade path as schemas evolve, or deployments can fail against existing databases.

**Acceptance criteria:** Add ordered migrations with a schema-version table, transactional application, and tests upgrading a fixture from every supported prior version.

### Issue #62 — Make database writes atomic across match and queue creation
**Area:** `apps/backend/src/store/sqlite-match-store.ts`, `apps/backend/src/store/sqlite-queue-store.ts`  
**Priority:** High  
**Type:** Data Consistency

**Problem:** If match persistence succeeds but work enqueueing fails, the application can accept a wager that no worker will settle.

**Acceptance criteria:** Persist the match and outbox/job record in one database transaction; fault-injection tests prove neither half is committed alone.

### Issue #63 — Use an outbox to deliver settlement events to asynchronous workers
**Area:** `apps/backend/src/store`, `apps/backend/src/services`  
**Priority:** High  
**Type:** Distributed Systems

**Problem:** Calling a queue after committing a database transaction creates a crash window in which committed work is never dispatched.

**Acceptance criteria:** Add an outbox table and idempotent dispatcher; test process termination between write and dispatch followed by successful recovery.

### Issue #64 — Bound queue growth and define retention for terminal work
**Area:** `apps/backend/src/store/sqlite-queue-store.ts`, `apps/backend/src/services/polling.ts`  
**Priority:** Medium  
**Type:** Operations / Data Retention

**Problem:** Durable queues can grow indefinitely unless completed, failed, and superseded records have an explicit retention policy.

**Acceptance criteria:** Define per-state retention and maximum storage policy; cleanup is batched, preserves audit references, and is tested against active jobs.

### Issue #65 — Make SQLite concurrency settings explicit for production deployment
**Area:** `apps/backend/src/store`, `docs/infrastructure.md`  
**Priority:** Medium  
**Type:** Runtime Configuration

**Problem:** Multiple worker processes or container replicas can contend for SQLite writes unless journal mode, busy timeout, and single-writer assumptions are explicit.

**Acceptance criteria:** Configure and document supported concurrency mode; integration tests exercise simultaneous writes and fail startup when an unsupported multi-replica mode is requested.

### Issue #66 — Redact credentials and player identifiers from API logs
**Area:** `apps/backend/src`  
**Priority:** High  
**Type:** Privacy / Security

**Problem:** Request logs and error objects can expose wallet addresses, provider tokens, or identity-linking data beyond the operational need.

**Acceptance criteria:** Define a redaction policy and structured allowlist for logged fields; tests verify secrets and sensitive identifiers are masked in success and failure paths.

### Issue #67 — Add a retention and deletion policy for linked chess identities
**Area:** `apps/backend/src/services/player-identity.ts`, `docs/security.md`  
**Priority:** Medium  
**Type:** Privacy Governance

**Problem:** The project needs to state how long platform usernames, proofs, and linkage records are retained and how a user can unlink them.

**Acceptance criteria:** Document purpose, retention, deletion behavior, and on-chain data limits; implement removal of off-chain linkage data without rewriting immutable settlement records.

### Issue #68 — Support key rotation without discarding pending settlement work
**Area:** `apps/backend/src/services/oracle-submit.ts`, `apps/backend/src`  
**Priority:** High  
**Type:** Operations / Key Management

**Problem:** Rotating a signer should not strand queued work or require editing durable jobs that were created under the previous key.

**Acceptance criteria:** Load the current signer through a managed provider, validate its on-chain role before work begins, and test rotation while pending jobs remain queued.

### Issue #69 — Add deterministic replay tooling for a failed settlement job
**Area:** `apps/backend/src/services`, `apps/backend/tests`  
**Priority:** Medium  
**Type:** Incident Response

**Problem:** Operators need to reproduce a failed decision from its stored inputs without re-fetching a changing upstream game response.

**Acceptance criteria:** Provide a restricted replay command that uses persisted normalized evidence and a dry-run mode; test replay determinism and prevent duplicate on-chain submission.

---

## Frontend and Player Experience

### Issue #70 — Render a single provider and routed application tree
**Area:** `apps/frontend/src/main.tsx`  
**Priority:** High  
**Type:** Application Composition

**Problem:** Rendering both a routed tree and a sibling application instance duplicates UI and can create independent wallet or network state.

**Acceptance criteria:** Mount one root composition with shared providers and router; tests verify one application shell and one wallet context are created.

### Issue #71 — Make the core wager workflow reachable from primary navigation
**Area:** `apps/frontend/src/routes/AppRouter.tsx`, `apps/frontend/src/pages/Home.tsx`  
**Priority:** Critical  
**Type:** Product Workflow

**Problem:** Users cannot complete the product's core create, deposit, and match-status journey if those components are not reachable from the routed application.

**Acceptance criteria:** Add discoverable routes and navigation for create-match, deposit, match details, and history; route tests cover direct links and refreshes.

### Issue #72 — Support fee-bump sponsorship for players without native XLM
**Area:** `apps/frontend/src/hooks/useTransactions.ts`, backend transaction service
**Priority:** Medium  
**Type:** Transaction Access

**Problem:** A player holding the stake asset but insufficient native XLM cannot submit the required network fee, even when a sponsor could safely cover it.

**Acceptance criteria:** Define an opt-in fee-bump flow with explicit sponsor limits and replay protections; test sponsored and unsponsored transactions on testnet without exposing sponsor keys to the browser.

### Issue #73 — Remove or implement claim and burn controls that currently do not perform a chain action
**Area:** `apps/frontend/src/hooks/useTransactions.ts`, `apps/frontend/src/components/claim-burn.tsx`  
**Priority:** High  
**Type:** Product Correctness

**Problem:** A visible money-related control must not imply success when it only logs a request or submits mock data.

**Acceptance criteria:** Implement the documented on-chain operation end to end or remove the unavailable action; UI tests verify no success message appears without a confirmed transaction.

### Issue #74 — Simulate the exact transaction the connected wallet will sign
**Area:** `apps/frontend/src/hooks/useTransactions.ts`  
**Priority:** High  
**Type:** Transaction Safety

**Problem:** Simulating a placeholder XDR does not validate the actual contract method, arguments, authorization tree, or network that will be submitted.

**Acceptance criteria:** Build once from typed operation inputs and simulate that exact invocation before signing; tests compare simulation and submission method and arguments.

### Issue #75 — Wait for ledger inclusion before showing a transaction as successful
**Area:** `apps/frontend/src/hooks/useTransactions.ts`  
**Priority:** Critical  
**Type:** Transaction State

**Problem:** A returned transaction hash can still fail during submission or never be included, so immediate success feedback misleads users about fund movement.

**Acceptance criteria:** Track submitted, pending, confirmed, and failed states using Soroban transaction polling; tests cover timeout, inclusion, and terminal failure.

### Issue #76 — Resolve supported assets from network configuration before offering them
**Area:** `apps/frontend/src/components/CreateMatch.tsx`, `apps/frontend/src/config`  
**Priority:** High  
**Type:** Asset Configuration

**Problem:** A hard-coded or empty token address can present an asset option that the selected network cannot actually use.

**Acceptance criteria:** Load token contract ID, symbol, and decimals from validated network configuration; hide or disable an asset when deployment metadata is missing.

### Issue #77 — Preserve the on-chain lifecycle state in match detail responses
**Area:** `apps/frontend/src/components/DepositStake.tsx`, `apps/frontend/src/types.ts`  
**Priority:** High  
**Type:** State Modeling

**Problem:** A component that receives participant addresses but not match state cannot reliably decide whether deposit is still allowed.

**Acceptance criteria:** Include typed state and per-player deposit flags in match details; terminal states disable the action and render a reason from the contract state.

### Issue #78 — Base pending-match progress on deposit flags rather than address presence
**Area:** `apps/frontend/src/components/MatchStatus.tsx`  
**Priority:** Medium  
**Type:** Status Accuracy

**Problem:** Participant addresses exist before either deposit, so showing them as evidence of deposited funds reports incorrect match progress.

**Acceptance criteria:** Read explicit deposit flags or verified deposit events and test zero, one, and two-deposit states.

### Issue #79 — Scope cached match reads by network and contract deployment
**Area:** `apps/frontend/src/pages/history-cache.ts`, `apps/frontend/src`
**Priority:** High  
**Type:** Cache Isolation

**Problem:** Reusing cached match data after switching networks or contract deployments can display a valid-looking record from a different chain.

**Acceptance criteria:** Include network identity and contract ID in every cache key; tests verify cache misses after either value changes and preserve valid same-deployment reuse.

### Issue #80 — Provide a default Soroban read path when no injected fetch callback is supplied
**Area:** `apps/frontend/src/components/MatchStatus.tsx`  
**Priority:** Medium  
**Type:** Component Contract

**Problem:** Required contract and RPC configuration is ineffective if the component silently requires an undocumented callback to read match state.

**Acceptance criteria:** Either implement the default reader or make the callback an explicit required prop at compile time; tests cover missing configuration and successful reads.

### Issue #81 — Separate transaction history from wager history in the History page
**Area:** `apps/frontend/src/pages/History.tsx`  
**Priority:** High  
**Type:** Data Presentation

**Problem:** Generic network transaction fee and success fields do not establish stake amount, winner, or payout for an escrow match.

**Acceptance criteria:** Build wager rows from contract match records or decoded escrow events; label network transaction details separately and test win, draw, refund, and unrelated transaction cases.

### Issue #82 — Convert leaderboard smallest-unit values using verified token metadata
**Area:** `apps/frontend/src/pages/Leaderboard.tsx`  
**Priority:** High  
**Type:** Financial UX

**Problem:** Raw integers and shortened token addresses are not meaningful monetary values to players.

**Acceptance criteria:** Display amount with symbol and decimals sourced from trusted network metadata; unknown assets remain explicitly denominated rather than guessed.

### Issue #83 — Add a wallet transaction review summary before signature
**Area:** `apps/frontend/src/hooks/useTransactions.ts`, `apps/frontend/src/components`  
**Priority:** High  
**Type:** User Safety

**Problem:** Before signing a wager, users need a readable summary of the opponent, asset, stake, network, and contract action.

**Acceptance criteria:** Present a review step derived from the same typed inputs used to construct the transaction; tests prove the displayed summary matches the submitted arguments.

### Issue #84 — Prevent duplicate submissions while wallet signing is unresolved
**Area:** `apps/frontend/src/hooks/useTransactions.ts`  
**Priority:** High  
**Type:** Transaction UX

**Problem:** Repeated clicks or a slow wallet prompt can start competing operations for one intent and leave users unsure which transaction to sign.

**Acceptance criteria:** Use an explicit operation state keyed by the action and form payload; repeated triggers are ignored until the attempt reaches a terminal state.

### Issue #85 — Keep wallet account changes synchronized with pending views
**Area:** `apps/frontend/src/providers/WalletProvider.tsx`, `apps/frontend/src/hooks/useWallet.ts`  
**Priority:** Medium  
**Type:** Wallet State

**Problem:** Changing accounts while a match or transaction view is open can leave actions bound to stale account data.

**Acceptance criteria:** Subscribe to account-change events, invalidate account-scoped reads, and require a fresh confirmation before signing with the new account.

### Issue #86 — Detect network mismatch before any read or signature request
**Area:** `apps/frontend/src/hooks/useNetworkStatus.ts`, `apps/frontend/src/hooks/useTransactions.ts`  
**Priority:** High  
**Type:** Network Safety

**Problem:** A wallet on the wrong Stellar network can sign an operation that targets an unexpected deployment or fails with confusing results.

**Acceptance criteria:** Compare wallet and app network identity before simulation and signing; tests verify mismatches block writes and explain the expected network.

### Issue #87 — Add a transaction recovery view for interrupted wallet flows
**Area:** `apps/frontend/src/hooks/useTransactions.ts`, `apps/frontend/src/pages`  
**Priority:** Medium  
**Type:** Recovery UX

**Problem:** A browser refresh after wallet approval can discard the pending hash and leave the user unable to determine whether the transaction settled.

**Acceptance criteria:** Persist only non-secret pending transaction references, restore their status after reload, and clear them after a terminal result.

### Issue #88 — Show a distinct state when a game is still being played
**Area:** `apps/frontend/src/components/MatchStatus.tsx`  
**Priority:** Medium  
**Type:** Status UX

**Problem:** Users need to distinguish an unfinished external chess game from a failed oracle check or a completed result awaiting settlement.

**Acceptance criteria:** Map backend pending, verification, settlement, and failure states to separate accessible labels and tests.

### Issue #89 — Add safe external-link handling for chess game references
**Area:** `apps/frontend/src/components`, `apps/frontend/src/pages`  
**Priority:** Low  
**Type:** Link Safety

**Problem:** User-supplied or provider-derived game URLs must not be rendered as arbitrary schemes or unsafe external links.

**Acceptance criteria:** Validate platform host and URL scheme, use safe new-tab attributes where appropriate, and test rejection of javascript and lookalike hosts.

### Issue #90 — Add first-run network and wallet setup without exposing unsupported actions
**Area:** `apps/frontend/src/pages/Home.tsx`, `apps/frontend/src/providers/WalletProvider.tsx`  
**Priority:** Medium  
**Type:** Onboarding

**Problem:** A disconnected user needs a clear route to connect and select a supported network before encountering controls that cannot yet work.

**Acceptance criteria:** Provide a compact setup flow driven by actual deployment configuration; tests cover disconnected, unsupported network, and ready states.

### Issue #91 — Support keyboard operation of transaction dialogs and menus
**Area:** `apps/frontend/src/components`, `apps/frontend/src/pages`  
**Priority:** Medium  
**Type:** Accessibility

**Problem:** Focus can become trapped or lost during wallet and transaction dialogs, preventing keyboard and assistive-technology users from completing a wager.

**Acceptance criteria:** Dialogs manage focus, expose names and status announcements, and restore focus on close; keyboard tests cover open, confirm, cancel, and error.

### Issue #92 — Display provider and chain source timestamps on match results
**Area:** `apps/frontend/src/components/MatchStatus.tsx`  
**Priority:** Low  
**Type:** Transparency

**Problem:** A displayed result without its verification and settlement timestamps leaves users unable to tell whether data is current or final.

**Acceptance criteria:** Show the provider verification time and confirmed ledger time when available, distinguish them visually, and omit them rather than fabricate values.

---

## Deployment and Runtime Operations

### Issue #93 — Isolate shared testnet deployments by pull request
**Area:** `.github/workflows`, `scripts/deploy_testnet.sh`
**Priority:** Medium  
**Type:** Environment Isolation

**Problem:** Concurrent pull-request testing against one mutable testnet deployment can overwrite contract IDs and invalidate another run's results.

**Acceptance criteria:** Create a uniquely identified deployment namespace or serialize shared deployments; record ownership and clean up only resources created by the completed run.

### Issue #94 — Verify the deployed signer can authorize the configured admin role
**Area:** `scripts/deploy_testnet.sh`, `scripts/deploy_mainnet.sh`
**Priority:** High  
**Type:** Deployment Authorization

**Problem:** A deployment can initialize an admin address that differs from the configured key, leaving operators unable to manage the live contracts.

**Acceptance criteria:** Compare the configured signer address with the initialized admin readback before publishing deployment metadata; fail with a redacted, actionable mismatch report.

### Issue #95 — Publish a signed deployment manifest tied to the source revision
**Area:** `scripts`, `.github/workflows/deploy.yml`  
**Priority:** High  
**Type:** Supply Chain / Operations

**Problem:** Contract IDs need a tamper-evident association with the source commit, artifact hashes, network, and initialization parameters.

**Acceptance criteria:** Generate a machine-readable manifest, sign or attest it in CI, and verify the attestation before the frontend consumes the deployment.

### Issue #96 — Require a second approver for production token and oracle changes
**Area:** `.github/workflows`, deployment configuration, `docs/runbook.md`
**Priority:** High  
**Type:** Change Governance

**Problem:** Changing the trusted token or oracle changes the asset and result trust boundary; a single operator should not be able to publish such a change without independent review.

**Acceptance criteria:** Gate production changes behind an independent approval and record the reviewed values in the release evidence; test that deployment cannot proceed without approval.

### Issue #97 — Check Stellar CLI protocol compatibility before contract deployment
**Area:** `scripts/build.sh`, `scripts/deploy_testnet.sh`, `scripts/deploy_mainnet.sh`
**Priority:** Medium  
**Type:** Tool Compatibility

**Problem:** A CLI version that cannot decode the contract's target protocol or spec can fail mid-deployment or invoke methods with incompatible encoding.

**Acceptance criteria:** Declare supported CLI and protocol versions, verify them before deployment starts, and test that unsupported versions fail before any network mutation.

### Issue #98 — Add a contract upgrade compatibility check before publishing new client IDs
**Area:** `scripts`, `contracts`, `.github/workflows`  
**Priority:** High  
**Type:** Upgrade Safety

**Problem:** A deployment that changes contract interface or stored-state layout can silently break an already released frontend or backend.

**Acceptance criteria:** Compare exported contract specifications and storage schema versions against the prior manifest; require an explicit compatibility report for breaking changes.

### Issue #99 — Add a canary environment for frontend and backend releases
**Area:** `.github/workflows`, `docs/deployment.md`  
**Priority:** Medium  
**Type:** Release Engineering

**Problem:** A testnet contract deployment alone does not validate the production frontend and oracle runtime configuration as a combined release.

**Acceptance criteria:** Define a canary release target with isolated credentials and a smoke match; promotion requires observed health and a documented rollback window.

### Issue #100 — Make deployment scripts safe to resume after partial failure
**Area:** `scripts/deploy_testnet.sh`, `scripts/deploy_mainnet.sh`  
**Priority:** High  
**Type:** Deployment Reliability

**Problem:** A failure after deploying one contract but before initialization can leave orphan deployments and an ambiguous rerun state.

**Acceptance criteria:** Record each completed step in a run manifest, detect and report partial state on rerun, and avoid silently deploying duplicate instances.

### Issue #101 — Add a test for environment-variable isolation between frontend and backend
**Area:** `apps/frontend`, `apps/backend`, `.env.example`  
**Priority:** High  
**Type:** Secret Handling

**Problem:** Build-time frontend variables are public, but server-only signer and provider credentials must never be bundled into client assets.

**Acceptance criteria:** Separate public and private configuration schemas and add a production bundle scan that fails if known server-only variable names or values appear.

### Issue #102 — Pin and attest all third-party action dependencies
**Area:** `.github/workflows`  
**Priority:** Medium  
**Type:** Supply Chain Security

**Problem:** Workflow actions referenced by mutable tags can change behavior without a reviewed repository change.

**Acceptance criteria:** Pin external actions to immutable commit SHAs, document update cadence, and add a check that rejects unpinned action references.

### Issue #103 — Add an SBOM for release artifacts and contract dependencies
**Area:** `.github/workflows`, `Cargo.lock`, `apps/backend/package-lock.json`  
**Priority:** Medium  
**Type:** Supply Chain Transparency

**Problem:** Operators cannot quickly inventory the direct and transitive components included in a deployed backend or contract build.

**Acceptance criteria:** Generate machine-readable CycloneDX or SPDX inventories for release artifacts and attach them to the corresponding build provenance.

### Issue #104 — Define tested recovery objectives for the oracle database
**Area:** `docs/runbook.md`, `apps/backend/src/store`  
**Priority:** Medium  
**Type:** Disaster Recovery

**Problem:** Durable job data is only useful if backups, restore procedures, and expected recovery loss are defined and rehearsed.

**Acceptance criteria:** Document backup frequency, retention, recovery-point and recovery-time goals; automate a restore test that verifies pending settlements survive.

### Issue #105 — Add capacity limits and disk-pressure alarms for persistent storage
**Area:** `apps/backend/src/store`, `docs/infrastructure.md`  
**Priority:** Medium  
**Type:** Operations

**Problem:** Persistent SQLite queues and match records can exhaust the runtime volume without warning, interrupting settlement processing.

**Acceptance criteria:** Measure database size, configure a supported capacity threshold, alert before exhaustion, and verify cleanup never deletes pending work.

### Issue #106 — Monitor settlement age from match activation to confirmed payout
**Area:** `apps/backend/src/services`, `docs/infrastructure.md`  
**Priority:** High  
**Type:** Service-Level Observability

**Problem:** A process can be healthy while active matches silently wait too long for verification or chain settlement.

**Acceptance criteria:** Record stage timestamps and publish age percentiles plus threshold alerts; tests verify metrics distinguish provider wait from chain submission delay.

### Issue #107 — Add an alert for sustained disagreement between game providers and chain outcomes
**Area:** `apps/backend/src/services`, `docs/runbook.md`  
**Priority:** High  
**Type:** Fraud and Incident Detection

**Problem:** Provider data anomalies or a compromised reporter may only become visible after repeated outcomes disagree with independent evidence.

**Acceptance criteria:** Define a review signal using independently available evidence and thresholds; alerts must not automatically reverse or settle funds.

### Issue #108 — Document and test database restore while the worker is running
**Area:** `apps/backend/src/store`, `apps/backend/tests`  
**Priority:** Medium  
**Type:** Recovery Safety

**Problem:** Restoring a database under a live queue worker can replay or lose settlement work if the worker is not paused and reconciled.

**Acceptance criteria:** Provide an operational command or procedure that quiesces workers, validates the restored schema, reconciles active jobs, and resumes safely.

### Issue #109 — Make runtime shutdown drain or checkpoint active work before exit
**Area:** `apps/backend/src/shutdown.ts`, `apps/backend/src/services/polling.ts`  
**Priority:** Medium  
**Type:** Process Lifecycle

**Problem:** A graceful process exit should not leave a job marked in progress without a lease expiry or recoverable checkpoint.

**Acceptance criteria:** Stop new claims, finish or release active leases, close storage cleanly, and test shutdown at each worker lifecycle phase.

---

## Product, Governance, and Quality

### Issue #110 — Publish explicit eligibility rules for supported games
**Area:** `docs`, `apps/backend/src/services/validate-game-service.ts`  
**Priority:** High  
**Type:** Product Policy

**Problem:** Players need to know before staking which time controls, variants, game visibility, and completion conditions the oracle can verify.

**Acceptance criteria:** Define supported game rules in user-facing docs and encode every machine-checkable condition in validation tests with clear rejection reasons.

### Issue #111 — Define the policy for provider outages during an active wager
**Area:** `docs/runbook.md`, `apps/backend/src/services`  
**Priority:** High  
**Type:** Product Policy / Operations

**Problem:** A prolonged external platform outage can leave a wager unresolved, and the current user-facing remedy and deadline need to be explicit.

**Acceptance criteria:** Specify operator escalation, participant communication, and on-chain timeout interaction; test that backend outage handling never invents a game outcome.

### Issue #112 — Publish a fee and net-payout calculation before wallet approval
**Area:** `apps/frontend/src`, `docs/api-reference.md`  
**Priority:** Medium  
**Type:** Financial Transparency

**Problem:** Players need to understand stake, potential gross payout, network fee estimate, and any platform charge before authorizing a transaction.

**Acceptance criteria:** Define which fees exist, calculate them from current configuration, and show gross versus net amounts without promising an estimated network fee as exact.

### Issue #113 — Define a minimum-age and jurisdiction eligibility policy for wagering
**Area:** `docs/security.md`, `docs/deployment.md`  
**Priority:** High  
**Type:** Compliance / Product Governance

**Problem:** A real-money wagering interface needs an explicit policy for who may access the service and which jurisdictions are supported.

**Acceptance criteria:** Record a reviewed policy and deployment enforcement responsibilities; ensure the frontend does not imply universal legal availability.

### Issue #114 — Add a documented responsible-play and self-exclusion flow
**Area:** `apps/frontend/src`, `docs`  
**Priority:** Medium  
**Type:** Player Protection

**Problem:** Users need clear controls and support guidance for limiting or stopping their participation in wagering.

**Acceptance criteria:** Define available self-exclusion or usage-limit controls, communicate their on-chain/off-chain scope, and test that excluded accounts cannot start the protected workflow where enforcement exists.

### Issue #115 — Establish a public status page for chain and oracle service incidents
**Area:** `docs/infrastructure.md`, deployment configuration  
**Priority:** Medium  
**Type:** Service Communication

**Problem:** During RPC, provider, or oracle incidents, participants need one authoritative place to distinguish a service outage from a failed wager.

**Acceptance criteria:** Publish component-level availability and incident updates without exposing signer details; define owner and update procedure in the runbook.

### Issue #116 — Define support evidence requirements for disputed settlements
**Area:** `docs/runbook.md`, `apps/backend/src`  
**Priority:** Medium  
**Type:** Support Operations

**Problem:** Support cannot investigate a payout dispute consistently without a standard set of match, provider, transaction, and ledger references.

**Acceptance criteria:** Define a privacy-conscious evidence bundle and retrieval procedure; verify it contains no signing secrets or unnecessary identity data.

### Issue #117 — Add an API compatibility policy for backend consumers
**Area:** `apps/backend/src/routes`, `docs/api-reference.md`  
**Priority:** Medium  
**Type:** API Governance

**Problem:** Frontend and third-party consumers need notice when response fields, error codes, or endpoint semantics change.

**Acceptance criteria:** Define versioning and deprecation rules, publish an OpenAPI contract, and add a compatibility check for breaking schema changes in CI.

### Issue #118 — Specify a single source of truth for network and contract metadata
**Area:** `environments.toml`, `.env.example`, `apps/frontend/src`, `apps/backend/src`  
**Priority:** High  
**Type:** Configuration Governance

**Problem:** Duplicated environment definitions can make frontend, backend, scripts, and docs target different RPC endpoints or contract IDs.

**Acceptance criteria:** Establish a canonical schema and generate or validate all consumer configuration against it; tests reject conflicting network identities.

### Issue #119 — Define ownership and review rules for production configuration changes
**Area:** `.github/CODEOWNERS`, `docs/contributing.md`  
**Priority:** Medium  
**Type:** Change Governance

**Problem:** Changes to RPC endpoints, contract IDs, token addresses, or deployment policies can alter production behavior without a domain-owner review.

**Acceptance criteria:** Assign owners for sensitive paths and require the relevant review in branch protection; document emergency override and audit requirements.

### Issue #120 — Add a contract-interface compatibility fixture shared by clients
**Area:** `contracts`, `apps/backend`, `apps/frontend`  
**Priority:** High  
**Type:** Cross-Repository Contract

**Problem:** Independent client bindings can drift from the deployed contract ABI even when each package compiles successfully.

**Acceptance criteria:** Generate a versioned interface fixture from contract specs and test frontend and backend serializers against identical method and error definitions.

### Issue #121 — Add deterministic test fixtures for external chess-provider payloads
**Area:** `apps/backend/tests`, `apps/backend/src/fetchers`  
**Priority:** Medium  
**Type:** Test Data Quality

**Problem:** Provider behavior changes can break parsers without a stable, privacy-safe set of payload examples for known edge cases.

**Acceptance criteria:** Store sanitized fixtures for decisive, drawn, ongoing, malformed, and changed-schema responses; parser tests run without network access.

### Issue #122 — Add fault-injection tests for every settlement boundary
**Area:** `apps/backend/tests`, `contracts/escrow/src/tests_e2e.rs`  
**Priority:** High  
**Type:** Failure Testing

**Problem:** Happy-path tests do not establish recovery behavior when storage, provider lookup, signing, RPC submission, or confirmation fails between stages.

**Acceptance criteria:** Inject failure at each documented boundary and assert the match remains recoverable, no duplicate payout occurs, and operator state is actionable.

### Issue #123 — Propagate W3C trace context through asynchronous oracle jobs
**Area:** `apps/backend/src`, `apps/frontend/src`, `docs/infrastructure.md`  
**Priority:** Medium  
**Type:** Observability

**Problem:** A trace started by an HTTP request cannot currently be continued reliably through durable queue processing and later provider or RPC calls.

**Acceptance criteria:** Persist trace context with queued work, resume it on worker execution and retries, and verify traces contain no wallet secrets or provider credentials.

### Issue #124 — Add a supported-version matrix for Stellar protocol and SDK upgrades
**Area:** `rust-toolchain.toml`, `Cargo.toml`, `apps/backend/package.json`, `docs`  
**Priority:** Medium  
**Type:** Compatibility Policy

**Problem:** Pinning individual tool versions does not describe which Stellar protocol, Soroban SDK, and wallet combinations are supported together.

**Acceptance criteria:** Publish a tested compatibility matrix and add a scheduled compatibility build before planned protocol or SDK upgrades.

### Issue #125 — Define measurable production readiness gates for wagering launch
**Area:** `docs/deployment.md`, `docs/runbook.md`  
**Priority:** High  
**Type:** Release Governance

**Problem:** A checklist of individual tasks does not define objective launch thresholds for settlement reliability, incident recovery, capacity, or user support.

**Acceptance criteria:** Specify measurable go/no-go thresholds, evidence owners, and rollback authority; require the release review to record results for each gate.

