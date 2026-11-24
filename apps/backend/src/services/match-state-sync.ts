import { isMatchState } from "../store/match-store.js";
import type { MatchState, MatchStorePort } from "../store/match-store.js";
import type { ChainMatch } from "./oracle-submit.js";
import logger from "../logger.js";

export interface MatchStateReader {
  getMatch(matchId: number): Promise<ChainMatch>;
}

function parseChainState(state: unknown): MatchState | null {
  if (!Array.isArray(state) || state.length !== 1 || !isMatchState(state[0])) {
    return null;
  }
  return state[0];
}

export async function syncMatchStates(
  store: MatchStorePort,
  chain: MatchStateReader,
): Promise<void> {
  const matches = await store.listMatchesForStateSync();
  for (const match of matches) {
    try {
      const onChain = await chain.getMatch(match.matchId);
      if (
        onChain.id !== BigInt(match.matchId) ||
        onChain.game_id !== match.gameId ||
        onChain.player1 !== match.player1 ||
        onChain.player2 !== match.player2
      ) {
        logger.warn(
          { match_id: match.matchId },
          "match_state_sync_identity_mismatch",
        );
        continue;
      }
      const state = parseChainState(onChain.state);
      if (!state) {
        logger.warn(
          { match_id: match.matchId },
          "match_state_sync_unrecognized_state",
        );
        continue;
      }
      const change = await store.updateMatchState(match.matchId, state);
      if (change) {
        logger.info(
          {
            match_id: match.matchId,
            previous_state: change.previousState,
            state,
          },
          "match_state_changed",
        );
      }
    } catch (error) {
      logger.warn(
        {
          match_id: match.matchId,
          error: error instanceof Error ? error.message : String(error),
        },
        "match_state_sync_failed",
      );
    }
  }
}

export function startMatchStateSync(
  store: MatchStorePort,
  chain: MatchStateReader,
  intervalMs = 15_000,
): () => Promise<void> {
  let inFlight: Promise<void> | undefined;
  const sync = () => {
    if (inFlight) return;
    inFlight = syncMatchStates(store, chain)
      .catch((error) =>
        logger.error({ error }, "match_state_sync_worker_failed"),
      )
      .finally(() => {
        inFlight = undefined;
      });
  };
  sync();
  const timer = setInterval(sync, intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await inFlight;
  };
}
