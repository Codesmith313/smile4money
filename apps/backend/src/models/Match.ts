import { matchStore } from '../store/index.js';
import type { MatchState } from '../store/match-store.js';

export interface MatchDocument {
  matchId: number;
  player1: string;
  player2: string;
  stakeAmount: number;
  token: string;
  gameId: string;
  platform: string;
  state: MatchState;
}

export interface MatchQueryOptions {
  player?: string;
  status?: MatchState | MatchState[];
  fromDate?: number | Date;
  toDate?: number | Date;
  minStake?: number;
  maxStake?: number;
  limit?: number;
  cursor?: string;
}

export interface MatchQueryResult {
  matches: MatchDocument[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface PlayerStatistics {
  player: string;
  totalMatches: number;
  wins: number;
  losses: number;
  draws: number;
  winrate: number;
  earnings: Record<string, number>;
}

export interface MatchStatistics {
  totalMatches: number;
  players: PlayerStatistics[];
  earningsByCurrency: Record<string, number>;
}

export class Match {
  static async deleteMany(_filter: Record<string, unknown> = {}): Promise<void> {
    matchStore.clear();
  }

  static async findOne(query: { gameId: string }): Promise<MatchDocument | null> {
    return matchStore.findByGameId(query.gameId);
  }

  static async countDocuments(): Promise<number> {
    return matchStore.count();
  }

  static async queryMatches(options: MatchQueryOptions = {}): Promise<MatchQueryResult> {
    return matchStore.queryMatches(options);
  }

  static async getStatistics(): Promise<MatchStatistics> {
    return matchStore.getStatistics();
  }
}