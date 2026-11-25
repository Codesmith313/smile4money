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
    depositedByPlayer1: { type: Boolean },
    depositedByPlayer2: { type: Boolean },
  },
  { timestamps: true, strict: false, collection: 'matches' },
);

export const Match: Model<MatchRecord> =
  (mongoose.models.Match as Model<MatchRecord>) ?? mongoose.model<MatchRecord>('Match', matchSchema);

export default Match;
