/**
 * Step 1: Trading cadence + market sentinel tests.
 *
 * Covers the pure decision logic (volatility, sleep sizing, wake mode,
 * evolution cooldown) and the KV-backed snapshot ring buffer.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  assessVolatility,
  decideTradingSleep,
  normalizeTradingCadence,
  shouldRunEvolution,
  resolveWakeMode,
} from "../trading/cadence.js";
import {
  readSnapshots,
  recordSnapshot,
  MAX_SNAPSHOTS,
} from "../trading/sentinel.js";
import { DEFAULT_TRADING_CADENCE_CONFIG } from "../types.js";
import type { MarketSnapshot, TradingCadenceConfig } from "../types.js";
import { createTestDb } from "./mocks.js";
import type { AutomatonDatabase } from "../types.js";

const CFG: TradingCadenceConfig = { ...DEFAULT_TRADING_CADENCE_CONFIG };

function snap(price: number, offsetMs: number, now: number): MarketSnapshot {
  return {
    symbol: "BTC/MXN",
    price,
    timestamp: new Date(now - offsetMs).toISOString(),
  };
}

describe("assessVolatility", () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);

  it("returns flat/non-volatile with fewer than 2 snapshots", () => {
    expect(assessVolatility([], CFG, now).volatile).toBe(false);
    expect(assessVolatility([snap(100, 0, now)], CFG, now).volatile).toBe(false);
  });

  it("flags a flat market as non-volatile", () => {
    const snaps = [
      snap(1_000_000, 600_000, now),
      snap(1_000_100, 300_000, now),
      snap(1_000_050, 0, now),
    ];
    const a = assessVolatility(snaps, CFG, now);
    expect(a.volatile).toBe(false);
    expect(a.movePct).toBeLessThan(CFG.volatilityThresholdPct);
  });

  it("flags a large swing as volatile", () => {
    // 1% swing >> 0.5% threshold
    const snaps = [
      snap(1_000_000, 600_000, now),
      snap(1_010_000, 0, now),
    ];
    const a = assessVolatility(snaps, CFG, now);
    expect(a.volatile).toBe(true);
    expect(a.movePct).toBeGreaterThanOrEqual(CFG.volatilityThresholdPct);
  });

  it("ignores snapshots older than the lookback window", () => {
    const snaps = [
      // ancient huge price, outside 15m lookback → must be ignored
      snap(2_000_000, CFG.lookbackMs + 60_000, now),
      snap(1_000_000, 120_000, now),
      snap(1_000_500, 0, now),
    ];
    const a = assessVolatility(snaps, CFG, now);
    expect(a.volatile).toBe(false);
  });

  it("does not compare one fresh sample with an ancient sample", () => {
    const snaps = [
      snap(2_000_000, CFG.lookbackMs + 60_000, now),
      snap(1_000_000, 0, now),
    ];
    const a = assessVolatility(snaps, CFG, now);
    expect(a.volatile).toBe(false);
    expect(a.sampleCount).toBe(1);
  });
});

describe("normalizeTradingCadence", () => {
  it("falls back for invalid values and keeps max >= min", () => {
    const normalized = normalizeTradingCadence({
      symbol: "  ",
      minIntervalMs: -1,
      maxIntervalMs: 10,
      volatilityThresholdPct: Number.NaN,
      lookbackMs: 0,
      evolutionIntervalMs: Infinity,
    });

    expect(normalized.symbol).toBe(DEFAULT_TRADING_CADENCE_CONFIG.symbol);
    expect(normalized.minIntervalMs).toBe(DEFAULT_TRADING_CADENCE_CONFIG.minIntervalMs);
    expect(normalized.maxIntervalMs).toBe(normalized.minIntervalMs);
    expect(normalized.volatilityThresholdPct).toBe(
      DEFAULT_TRADING_CADENCE_CONFIG.volatilityThresholdPct,
    );
    expect(normalized.lookbackMs).toBe(DEFAULT_TRADING_CADENCE_CONFIG.lookbackMs);
    expect(normalized.evolutionIntervalMs).toBe(
      DEFAULT_TRADING_CADENCE_CONFIG.evolutionIntervalMs,
    );
  });
});

describe("decideTradingSleep", () => {
  it("uses min interval when volatile", () => {
    const d = decideTradingSleep({ movePct: 2, volatile: true, sampleCount: 3 }, CFG);
    expect(d.sleepMs).toBe(CFG.minIntervalMs);
  });

  it("uses max interval when flat", () => {
    const d = decideTradingSleep({ movePct: 0.1, volatile: false, sampleCount: 3 }, CFG);
    expect(d.sleepMs).toBe(CFG.maxIntervalMs);
  });
});

describe("shouldRunEvolution", () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);

  it("runs when never run before", () => {
    expect(shouldRunEvolution(null, CFG, now)).toBe(true);
    expect(shouldRunEvolution(undefined, CFG, now)).toBe(true);
  });

  it("does not run within the cooldown", () => {
    const oneHourAgo = new Date(now - 3_600_000).toISOString();
    expect(shouldRunEvolution(oneHourAgo, CFG, now)).toBe(false);
  });

  it("runs after the cooldown elapses", () => {
    const dayAndABitAgo = new Date(now - CFG.evolutionIntervalMs - 1000).toISOString();
    expect(shouldRunEvolution(dayAndABitAgo, CFG, now)).toBe(true);
  });
});

describe("resolveWakeMode", () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);

  it("defaults to trading with no request", () => {
    expect(resolveWakeMode({ config: CFG, now })).toBe("trading");
  });

  it("honors an evolution request when cooldown elapsed", () => {
    expect(
      resolveWakeMode({
        requestedMode: "evolution",
        lastEvolutionAtIso: null,
        config: CFG,
        now,
      }),
    ).toBe("evolution");
  });

  it("downgrades an evolution request during cooldown to trading", () => {
    const recent = new Date(now - 60_000).toISOString();
    expect(
      resolveWakeMode({
        requestedMode: "evolution",
        lastEvolutionAtIso: recent,
        config: CFG,
        now,
      }),
    ).toBe("trading");
  });
});

describe("sentinel snapshot storage", () => {
  let db: AutomatonDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("round-trips snapshots", () => {
    expect(readSnapshots(db)).toEqual([]);
    recordSnapshot(db, { symbol: "BTC/MXN", price: 100, timestamp: new Date().toISOString() });
    const out = readSnapshots(db);
    expect(out.length).toBe(1);
    expect(out[0].price).toBe(100);
  });

  it("trims to the ring buffer cap", () => {
    for (let i = 0; i < MAX_SNAPSHOTS + 10; i++) {
      recordSnapshot(db, {
        symbol: "BTC/MXN",
        price: 100 + i,
        timestamp: new Date().toISOString(),
      });
    }
    const out = readSnapshots(db);
    expect(out.length).toBe(MAX_SNAPSHOTS);
    // Oldest kept should be price 110 (dropped first 10)
    expect(out[0].price).toBe(110);
  });

  it("returns [] on corrupt KV", () => {
    db.setKV("market_snapshots", "not json");
    expect(readSnapshots(db)).toEqual([]);
  });
});
