export interface MatchInput {
  player2: string;
  stakeAmount: number;
  token: string;
  gameId: string;
  platform: string;
}

export interface ValidationIssue {
  field: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; value: MatchInput }
  | { ok: false; errors: ValidationIssue[] };

const ALLOWED_PLATFORMS = ['lichess', 'chessdotcom', 'chess.com'];
const GAME_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export function validateMatchInput(input: unknown, address: string): ValidationResult {
  const body = (input ?? {}) as Record<string, unknown>;
  const errors: ValidationIssue[] = [];
  const { player2, stakeAmount, token, gameId, platform } = body;

  if (typeof player2 !== 'string' || !player2.trim()) {
    errors.push({ field: 'player2', message: 'player2 is required' });
  }
  if (typeof stakeAmount !== 'number' || !Number.isSafeInteger(stakeAmount) || stakeAmount <= 0) {
    errors.push({ field: 'stakeAmount', message: 'stakeAmount must be a positive safe integer' });
  }
  if (typeof token !== 'string' || !token.trim()) {
    errors.push({ field: 'token', message: 'token is required' });
  }
  if (typeof gameId !== 'string' || !gameId.trim()) {
    errors.push({ field: 'gameId', message: 'gameId is required' });
  } else {
    if (gameId.length > 128) {
      errors.push({ field: 'gameId', message: 'gameId is too long' });
    }
    if (!GAME_ID_PATTERN.test(gameId)) {
      errors.push({ field: 'gameId', message: 'gameId contains invalid characters' });
    }
  }
  if (typeof platform !== 'string' || !ALLOWED_PLATFORMS.includes(platform.toLowerCase())) {
    errors.push({ field: 'platform', message: 'platform must be lichess or chessdotcom' });
  }
  if (typeof player2 === 'string' && player2 === address) {
    errors.push({ field: 'player2', message: 'A player cannot create a match against themselves' });
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    value: {
      player2: player2 as string,
      stakeAmount: stakeAmount as number,
      token: token as string,
      gameId: gameId as string,
      platform: (platform as string).toLowerCase(),
    },
  };
}
