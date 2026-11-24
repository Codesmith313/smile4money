import { computeIdentityHash } from '../services/player-identity.js';
import { randomUUID } from 'node:crypto';

export interface MatchRecord {
  matchId: number;
  player1: string;
  player2: string;
  player1Username?: string; // Chess platform username for player1 (optional for backward compatibility)
  player2Username?: string; // Chess platform username for player2 (optional for backward compatibility)
  stakeAmount: number;
  token: string;
  gameId: string;
  platform: string;
  state: MatchState;
  /**
   * SHA-256 binding of (player1Username, player1, player2Username, player2),
   * computed once at creation (#1720). Verified against a fresh recomputation
   * before the oracle accepts a result — see
   * `services/player-identity.ts#verifyIdentityHash`. Undefined when the
   * match was created without both usernames captured (nothing to bind yet).
   */
  identityHash?: string;
  evidence?: CanonicalSettlementEvidence;
  /**
   * Timestamp (epoch ms) at which the match result was submitted. Used as the
   * anchor for the dispute window (#2115). Undefined until a result is
   * submitted.
   */
  resultSubmittedAt?: number;
  /**
   * Timestamp (epoch ms) after which disputes are no longer accepted (#2115).
   * Computed from `resultSubmittedAt` plus the configured dispute window
   * duration. Undefined until a result is submitted.
   */
  disputeDeadline?: number;
}

export type MatchState = 'Pending' | 'Active' | 'PendingResult' | 'Completed' | 'Cancelled';
const MATCH_STATE_VALUES = new Set<string>([
  'Pending',
  'Active',
  'PendingResult',
  'Completed',
  'Cancelled',
]);

export function isMatchState(value: unknown): value is MatchState {
  return typeof value === 'string' && MATCH_STATE_VALUES.has(value);
}

export interface WebhookSubscription {
  id: string;
  matchId: number;
  owner: string;
  url: string;
  secret: string;
  createdAt: number;
}

export interface WebhookDelivery {
  id: string;
  eventId: string;
  subscriptionId: string;
  url: string;
  secret: string;
  payload: string;
  attempts: number;
}

export interface MatchStateChange {
  match: MatchRecord;
  previousState: MatchState;
  state: MatchState;
}

export interface CanonicalSettlementEvidence {
  parserVersion: string;
  evaluatedAt: string;
  matchId: number;
  gameId: string;
  platform: string;
  provider: 'lichess' | 'chessdotcom';
  whitePlayer: string;
  blackPlayer: string;
  result: string | null;
  status: string;
  decision: 'verified' | 'player_identity_mismatch' | 'identity_hash_mismatch';
}

export interface CreateMatchPayload {
  player1: string;
  player2: string;
  player1Username?: string;
  player2Username?: string;
  stakeAmount: number;
  token: string;
  gameId: string;
  platform: string;
}

export interface MatchStorePort {
  createMatch(payload: CreateMatchPayload): Promise<MatchRecord>;
  findByGameId(gameId: string): Promise<MatchRecord | null>;
  findByMatchId(matchId: number): Promise<MatchRecord | null>;
  listMatchesByPlayer(address: string): Promise<MatchRecord[]>;
  listMatchesForStateSync(): Promise<MatchRecord[]>;
  updateMatchState(matchId: number, state: MatchState): Promise<MatchStateChange | null>;
  createWebhookSubscription(
    input: Omit<WebhookSubscription, 'createdAt'>,
  ): Promise<WebhookSubscription>;
  listWebhookSubscriptions(owner: string): Promise<Omit<WebhookSubscription, 'secret'>[]>;
  deleteWebhookSubscription(id: string, owner: string): Promise<boolean>;
  getDueWebhookDeliveries(now: number, limit: number): Promise<WebhookDelivery[]>;
  completeWebhookDelivery(
    id: string,
    result: { success: true } | { success: false; error: string; nextAttemptAt: number; terminal: boolean },
  ): Promise<void>;
  count(): Promise<number>;
  saveSettlementEvidence(evidence: CanonicalSettlementEvidence): Promise<void>;
  getSettlementEvidence(matchId: number): Promise<CanonicalSettlementEvidence | null>;
  getSettlementEvidenceHistory(matchId: number): Promise<CanonicalSettlementEvidence[]>;
}

export class MatchStore implements MatchStorePort {
  private matches = new Map<number, MatchRecord>();
  private gameIds = new Set<string>();
  private nextId = 0;
  private evidenceByMatch = new Map<number, CanonicalSettlementEvidence[]>();
  private webhookSubscriptions = new Map<string, WebhookSubscription>();
  private webhookDeliveries = new Map<string, WebhookDelivery & { nextAttemptAt: number; delivered: boolean; lastError?: string }>();

  async saveSettlementEvidence(evidence: CanonicalSettlementEvidence): Promise<void> {
    const records = this.evidenceByMatch.get(evidence.matchId) ?? [];
    records.push({ ...evidence });
    this.evidenceByMatch.set(evidence.matchId, records);
  }

  async getSettlementEvidence(matchId: number): Promise<CanonicalSettlementEvidence | null> {
    const records = this.evidenceByMatch.get(matchId);
    const evidence = records?.[records.length - 1];
    return evidence ? { ...evidence } : null;
  }

  async getSettlementEvidenceHistory(matchId: number): Promise<CanonicalSettlementEvidence[]> {
    return (this.evidenceByMatch.get(matchId) ?? []).map((record) => ({ ...record }));
  }

  async createMatch(payload: CreateMatchPayload): Promise<MatchRecord> {
    if (!Number.isSafeInteger(this.nextId) || this.nextId < 0) {
      throw new Error('Match identifier range exhausted');
    }
    if (this.gameIds.has(payload.gameId)) {
      throw new Error('duplicate game_id');
    }

    // #1720 — bind the identity captured at creation to the match record via
    // a hash, so a later divergence between the stored usernames/addresses
    // and what they were at creation time is detectable rather than silently
    // trusted. Only computable when both usernames were captured.
    const identityHash =
      payload.player1Username && payload.player2Username
        ? computeIdentityHash(
            payload.player1Username,
            payload.player1,
            payload.player2Username,
            payload.player2,
          )
        : undefined;

    const record: MatchRecord = {
      matchId: this.nextId,
      player1: payload.player1,
      player2: payload.player2,
      player1Username: payload.player1Username,
      player2Username: payload.player2Username,
      stakeAmount: payload.stakeAmount,
      token: payload.token,
      gameId: payload.gameId,
      platform: payload.platform,
      state: 'Pending',
      identityHash,
    };

    this.matches.set(this.nextId, record);
    this.gameIds.add(payload.gameId);
    this.nextId += 1;
    return record;
  }

  async findByGameId(gameId: string): Promise<MatchRecord | null> {
    for (const match of this.matches.values()) {
      if (match.gameId === gameId) {
        return match;
      }
    }
    return null;
  }

  async findByMatchId(matchId: number): Promise<MatchRecord | null> {
    const match = this.matches.get(matchId);
    return match ? { ...match } : null;
  }

  async listMatchesByPlayer(address: string): Promise<MatchRecord[]> {
    const normalizedAddress = address.toLowerCase();
    return [...this.matches.values()]
      .filter(
        (match) =>
          match.player1.toLowerCase() === normalizedAddress ||
          match.player2.toLowerCase() === normalizedAddress,
      )
      .map((match) => ({ ...match }));
  }

  async listMatchesForStateSync(): Promise<MatchRecord[]> {
    return [...this.matches.values()]
      .filter((match) => match.state !== 'Completed' && match.state !== 'Cancelled')
      .map((match) => ({ ...match }));
  }

  async updateMatchState(matchId: number, state: MatchState): Promise<MatchStateChange | null> {
    const match = this.matches.get(matchId);
    if (!match || match.state === state) return null;
    const previousState = match.state;
    match.state = state;
    const eventId = randomUUID();
    const payload = JSON.stringify({
      id: eventId,
      type: 'match.state_changed',
      occurredAt: new Date().toISOString(),
      data: { matchId, gameId: match.gameId, previousState, state },
    });
    for (const subscription of this.webhookSubscriptions.values()) {
      if (subscription.matchId === matchId) {
        const id = randomUUID();
        this.webhookDeliveries.set(id, {
          id,
          eventId,
          subscriptionId: subscription.id,
          url: subscription.url,
          secret: subscription.secret,
          payload,
          attempts: 0,
          nextAttemptAt: Date.now(),
          delivered: false,
        });
      }
    }
    return { match: { ...match }, previousState, state };
  }

  async createWebhookSubscription(
    input: Omit<WebhookSubscription, 'createdAt'>,
  ): Promise<WebhookSubscription> {
    const match = this.matches.get(input.matchId);
    if (!match) throw new Error('Match not found');
    if (
      match.player1.toUpperCase() !== input.owner.toUpperCase() &&
      match.player2.toUpperCase() !== input.owner.toUpperCase()
    ) {
      throw new Error('Only a match participant can subscribe to its webhooks');
    }
    const duplicate = [...this.webhookSubscriptions.values()].some(
      (subscription) =>
        subscription.matchId === input.matchId &&
        subscription.owner.toUpperCase() === input.owner.toUpperCase() &&
        subscription.url === input.url,
    );
    if (duplicate) throw new Error('UNIQUE constraint failed: webhook_subscriptions');
    const subscription = { ...input, owner: input.owner.toUpperCase(), createdAt: Date.now() };
    this.webhookSubscriptions.set(input.id, subscription);
    return { ...subscription };
  }

  async listWebhookSubscriptions(owner: string): Promise<Omit<WebhookSubscription, 'secret'>[]> {
    return [...this.webhookSubscriptions.values()]
      .filter((subscription) => subscription.owner.toUpperCase() === owner.toUpperCase())
      .map(({ secret: _secret, ...subscription }) => ({ ...subscription }));
  }

  async deleteWebhookSubscription(id: string, owner: string): Promise<boolean> {
    const subscription = this.webhookSubscriptions.get(id);
    if (!subscription || subscription.owner.toUpperCase() !== owner.toUpperCase()) return false;
    this.webhookSubscriptions.delete(id);
    for (const [deliveryId, delivery] of this.webhookDeliveries) {
      if (delivery.subscriptionId === id && !delivery.delivered) this.webhookDeliveries.delete(deliveryId);
    }
    return true;
  }

  async getDueWebhookDeliveries(now: number, limit: number): Promise<WebhookDelivery[]> {
    return [...this.webhookDeliveries.values()]
      .filter((delivery) => !delivery.delivered && delivery.nextAttemptAt <= now)
      .slice(0, limit)
      .map(({ nextAttemptAt: _next, delivered: _delivered, lastError: _error, ...delivery }) => ({ ...delivery }));
  }

  async completeWebhookDelivery(
    id: string,
    result: { success: true } | { success: false; error: string; nextAttemptAt: number; terminal: boolean },
  ): Promise<void> {
    const delivery = this.webhookDeliveries.get(id);
    if (!delivery) return;
    delivery.attempts += 1;
    if (result.success || result.terminal) delivery.delivered = true;
    else {
      delivery.nextAttemptAt = result.nextAttemptAt;
      delivery.lastError = result.error;
    }
  }

  async unlinkIdentities(address: string): Promise<number> {
    let count = 0;
    for (const match of this.matches.values()) {
      if (
        (match.player1 === address || match.player2 === address) &&
        (match.player1Username || match.player2Username || match.identityHash)
      ) {
        delete match.player1Username;
        delete match.player2Username;
        delete match.identityHash;
        count++;
      }
    }
    return count;
  }

  async count(): Promise<number> {
    return this.matches.size;
  }

  clear(): void {
    this.matches.clear();
    this.gameIds.clear();
    this.nextId = 0;
    this.evidenceByMatch.clear();
    this.webhookSubscriptions.clear();
    this.webhookDeliveries.clear();
  }
}
