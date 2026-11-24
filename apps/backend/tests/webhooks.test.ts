import { describe, expect, it, vi } from "vitest";
import { MatchStore } from "../src/store/match-store.js";
import {
  deliverWebhookBatch,
  signWebhookPayload,
  validateWebhookUrl,
  verifyWebhookSignature,
} from "../src/services/webhooks.js";
import { syncMatchStates } from "../src/services/match-state-sync.js";

async function createSubscribedStore() {
  const store = new MatchStore();
  await store.createMatch({
    player1: "GPLAYER1",
    player2: "GPLAYER2",
    stakeAmount: 100,
    token: "XLM",
    gameId: "game-1",
    platform: "lichess",
  });
  await store.createWebhookSubscription({
    id: "subscription-1",
    matchId: 0,
    owner: "GPLAYER1",
    url: "https://hooks.example.test/events",
    secret: "test-secret",
  });
  return store;
}

describe("match state webhooks", () => {
  it("creates one delivery only when the persisted match state changes", async () => {
    const store = await createSubscribedStore();

    await expect(store.updateMatchState(0, "Active")).resolves.toMatchObject({
      previousState: "Pending",
      state: "Active",
    });
    await expect(store.updateMatchState(0, "Active")).resolves.toBeNull();
    const deliveries = await store.getDueWebhookDeliveries(Date.now(), 10);
    expect(deliveries).toHaveLength(1);
    expect(JSON.parse(deliveries[0].payload).data).toEqual({
      matchId: 0,
      gameId: "game-1",
      previousState: "Pending",
      state: "Active",
    });
  });

  it("keeps subscription secrets private and enforces owner-only deletion", async () => {
    const store = await createSubscribedStore();

    const subscriptions = await store.listWebhookSubscriptions("gplayer1");
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]).toMatchObject({
      id: "subscription-1",
      matchId: 0,
      url: "https://hooks.example.test/events",
    });
    expect(subscriptions[0]).not.toHaveProperty("secret");
    expect(await store.deleteWebhookSubscription("subscription-1", "GATTACKER")).toBe(false);
    expect(await store.deleteWebhookSubscription("subscription-1", "GPLAYER1")).toBe(true);
  });

  it("syncs only identity-matched escrow state and emits the transition", async () => {
    const store = await createSubscribedStore();
    const chain = {
      getMatch: vi.fn().mockResolvedValue({
        id: 0n,
        game_id: "game-1",
        player1: "GPLAYER1",
        player2: "GPLAYER2",
        state: ["Active"],
      }),
    };

    await syncMatchStates(store, chain);
    expect(await store.findByMatchId(0)).toMatchObject({ state: "Active" });
    expect(await store.getDueWebhookDeliveries(Date.now(), 10)).toHaveLength(1);

    chain.getMatch.mockResolvedValue({
      id: 0n,
      game_id: "different-game",
      player1: "GPLAYER1",
      player2: "GPLAYER2",
      state: ["Completed"],
    });
    await syncMatchStates(store, chain);
    expect(await store.findByMatchId(0)).toMatchObject({ state: "Active" });
    expect(await store.getDueWebhookDeliveries(Date.now(), 10)).toHaveLength(1);
  });

  it("retries failed deliveries and marks successful delivery complete", async () => {
    const store = await createSubscribedStore();
    await store.updateMatchState(0, "Active");
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary error"))
      .mockResolvedValueOnce(undefined);
    const now = Date.now();

    await deliverWebhookBatch(store, send, now);
    expect(await store.getDueWebhookDeliveries(now + 999, 10)).toHaveLength(0);
    await deliverWebhookBatch(store, send, now + 1_001);

    expect(send).toHaveBeenCalledTimes(2);
    expect(await store.getDueWebhookDeliveries(now + 100_000, 10)).toHaveLength(
      0,
    );
  });

  it("signs the timestamp and exact payload and rejects a modified payload", () => {
    const signature = signWebhookPayload(
      "secret",
      "1730000000",
      '{"event":"test"}',
    );
    expect(
      verifyWebhookSignature(
        "secret",
        "1730000000",
        '{"event":"test"}',
        signature,
      ),
    ).toBe(true);
    expect(
      verifyWebhookSignature(
        "secret",
        "1730000000",
        '{"event":"changed"}',
        signature,
      ),
    ).toBe(false);
  });

  it("rejects insecure and local webhook endpoints", async () => {
    await expect(
      validateWebhookUrl("http://hooks.example.test/events"),
    ).rejects.toThrow("public HTTPS");
    await expect(
      validateWebhookUrl("https://localhost/events"),
    ).rejects.toThrow("public HTTPS");
  });
});
