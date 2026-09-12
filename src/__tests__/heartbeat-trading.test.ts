/**
 * Step 1: heartbeat tasks — market_sentinel + evolution_trigger.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the exchange adapter so the sentinel never hits the network.
const marketPriceMock = vi.fn<[], Promise<number>>();
vi.mock("../exchange/adapter.js", () => ({
  ExchangeAdapter: class {
    async getMarketPrice() {
      return marketPriceMock();
    }
  },
}));

import { BUILTIN_TASKS } from "../heartbeat/tasks.js";
import { readSnapshots, recordSnapshot } from "../trading/sentinel.js";
import {
  createTestDb,
  createTestIdentity,
  createTestConfig,
  MockConwayClient,
} from "./mocks.js";
import { DEFAULT_TRADING_CADENCE_CONFIG } from "../types.js";
import type {
  AutomatonDatabase,
  TickContext,
  HeartbeatLegacyContext,
} from "../types.js";

function tickCtx(db: AutomatonDatabase): TickContext {
  return {
    tickId: "t1",
    startedAt: new Date(),
    creditBalance: 10_000,
    usdcBalance: 1,
    survivalTier: "normal",
    lowComputeMultiplier: 4,
    config: { entries: [], defaultIntervalMs: 60_000, lowComputeMultiplier: 4 },
    db: db.raw,
  };
}

function legacyCtx(db: AutomatonDatabase, conway: MockConwayClient): HeartbeatLegacyContext {
  return {
    identity: createTestIdentity(),
    config: createTestConfig({ tradingCadence: { ...DEFAULT_TRADING_CADENCE_CONFIG } }),
    db,
    conway,
  };
}

describe("market_sentinel", () => {
  let db: AutomatonDatabase;
  let conway: MockConwayClient;

  beforeEach(() => {
    db = createTestDb();
    conway = new MockConwayClient();
    marketPriceMock.mockReset();
  });

  afterEach(() => db.close());

  it("records a snapshot and does not wake on a flat market", async () => {
    marketPriceMock.mockResolvedValue(1_000_000);
    db.setAgentState("sleeping");

    const result = await BUILTIN_TASKS.market_sentinel(tickCtx(db), legacyCtx(db, conway));

    expect(result.shouldWake).toBe(false);
    expect(readSnapshots(db).length).toBe(1);
    expect(db.getKV("last_market_sentinel")).toBeDefined();
  });

  it("wakes when volatility crosses the threshold and agent is sleeping", async () => {
    // Seed an older price so the new one is a >0.5% move.
    recordSnapshot(db, {
      symbol: "BTC/MXN",
      price: 1_000_000,
      timestamp: new Date(Date.now() - 120_000).toISOString(),
    });
    marketPriceMock.mockResolvedValue(1_010_000); // +1%
    db.setAgentState("sleeping");

    const result = await BUILTIN_TASKS.market_sentinel(tickCtx(db), legacyCtx(db, conway));

    expect(result.shouldWake).toBe(true);
    expect(result.message).toContain("moved");
  });

  it("does not wake a running agent even when volatile", async () => {
    recordSnapshot(db, {
      symbol: "BTC/MXN",
      price: 1_000_000,
      timestamp: new Date(Date.now() - 120_000).toISOString(),
    });
    marketPriceMock.mockResolvedValue(1_010_000);
    db.setAgentState("running");

    const result = await BUILTIN_TASKS.market_sentinel(tickCtx(db), legacyCtx(db, conway));

    expect(result.shouldWake).toBe(false);
  });

  it("never calls inference (no conway exec / model calls)", async () => {
    marketPriceMock.mockResolvedValue(1_000_000);
    await BUILTIN_TASKS.market_sentinel(tickCtx(db), legacyCtx(db, conway));
    expect(conway.execCalls.length).toBe(0);
  });
});

describe("evolution_trigger", () => {
  let db: AutomatonDatabase;
  let conway: MockConwayClient;

  beforeEach(() => {
    db = createTestDb();
    conway = new MockConwayClient();
  });

  afterEach(() => db.close());

  it("requests an evolution wake when never run before", async () => {
    const result = await BUILTIN_TASKS.evolution_trigger(tickCtx(db), legacyCtx(db, conway));
    expect(result.shouldWake).toBe(true);
    expect(db.getKV("requested_wake_mode")).toBe("evolution");
  });

  it("does not fire again within the cooldown", async () => {
    db.setKV("last_evolution_run", new Date().toISOString());
    const result = await BUILTIN_TASKS.evolution_trigger(tickCtx(db), legacyCtx(db, conway));
    expect(result.shouldWake).toBe(false);
    expect(db.getKV("requested_wake_mode")).toBeUndefined();
  });

  it("does not duplicate a pending evolution request", async () => {
    db.setKV("evolution_requested_at", new Date().toISOString());
    const result = await BUILTIN_TASKS.evolution_trigger(tickCtx(db), legacyCtx(db, conway));
    expect(result.shouldWake).toBe(false);
  });
});
