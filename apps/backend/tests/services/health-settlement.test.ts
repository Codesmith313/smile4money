import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

vi.mock("../../src/logger.js", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../src/services/stellar.js", () => ({ checkStellarRpc: vi.fn() }));
vi.mock("../../src/services/bottleneck-limiters.js", () => ({
  getAllLimiterStats: vi.fn(() => ({})),
}));
vi.mock("../../src/store/index.js", () => ({
  matchStore: { getSchemaVersion: vi.fn().mockResolvedValue(1) },
}));

import { runHealthCheck } from "../../src/services/health-service.js";
import { checkStellarRpc } from "../../src/services/stellar.js";
import {
  SettlementAgeMonitor,
  setSettlementAgeMonitor,
} from "../../src/services/settlement-age-monitor.js";
import { matchStore } from "../../src/store/index.js";

const BASE = { uptimeSeconds: 1, version: "test" };

afterEach(() => {
  setSettlementAgeMonitor(null);
});

beforeEach(() => {
  vi.mocked(checkStellarRpc).mockResolvedValue(undefined);
  vi.mocked(matchStore.getSchemaVersion).mockResolvedValue(1);
});

describe("runHealthCheck settlement metrics", () => {
  it("omits settlement data by default, even when a monitor is registered", async () => {
    const monitor = new SettlementAgeMonitor();
    monitor.recordStage(1, "activated");
    setSettlementAgeMonitor(monitor);

    const result = await runHealthCheck(BASE);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.settlement).toBeUndefined();
  });

  it("includes the settlement snapshot when requested", async () => {
    const monitor = new SettlementAgeMonitor();
    monitor.recordStage(1, "activated");
    setSettlementAgeMonitor(monitor);

    const result = await runHealthCheck({ ...BASE, includeSettlement: true });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.settlement?.openMatches).toBe(1);
      expect(result.payload.settlement?.open.provider_wait.count).toBe(1);
    }
  });

  it("reports null when requested but no monitor is active", async () => {
    const result = await runHealthCheck({ ...BASE, includeSettlement: true });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.settlement).toBeNull();
  });
});
