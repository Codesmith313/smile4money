import mongoose, { Schema, type Model } from 'mongoose';

export interface MatchRecord {
  matchId?: number;
  player1?: string;
  player2?: string;
  userId?: string;
  players?: string[];
  stakeAmount?: number;
  stake?: number;
  token?: string;
  gameId?: string;
  platform?: string;
  state?: string;
  status?: string;
  winner?: string;
  result?: string;
  evidence?: Record<string, unknown>;
  submission?: Record<string, unknown>;
  resultSubmission?: Record<string, unknown>;
  submissionStatus?: string;
  submissionError?: string;
  lastError?: string;
  retryCount?: number;
  retry_count?: number;
  retryHistory?: Array<Record<string, unknown>>;
  submissionAttempts?: Array<Record<string, unknown>>;
  lastRetryAt?: Date;
  retriedAt?: Date;
  lastAttemptAt?: Date;
  depositedByPlayer1?: boolean;
  depositedByPlayer2?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

const matchSchema = new Schema<MatchRecord>(
  {
    matchId: { type: Number },
    player1: { type: String },
    player2: { type: String },
    userId: { type: String },
    players: { type: [String], default: undefined },
    stakeAmount: { type: Number },
    stake: { type: Number },
    token: { type: String },
    gameId: { type: String },
    platform: { type: String },
    state: { type: String },
    status: { type: String },
    winner: { type: String },
    result: { type: String },
    evidence: { type: Schema.Types.Mixed },
    submission: { type: Schema.Types.Mixed },
    resultSubmission: { type: Schema.Types.Mixed },
    submissionStatus: { type: String },
    submissionError: { type: String },
    lastError: { type: String },
    retryCount: { type: Number, default: 0 },
    retry_count: { type: Number, default: 0 },
    retryHistory: { type: [Schema.Types.Mixed], default: [] },
    submissionAttempts: { type: [Schema.Types.Mixed], default: [] },
    lastRetryAt: { type: Date },
    retriedAt: { type: Date },
    lastAttemptAt: { type: Date },
    depositedByPlayer1: { type: Boolean },
    depositedByPlayer2: { type: Boolean },
  },
  { timestamps: true, strict: false, collection: 'matches' },
);

export const Match: Model<MatchRecord> =
  (mongoose.models.Match as Model<MatchRecord>) ?? mongoose.model<MatchRecord>('Match', matchSchema);

export default Match;
