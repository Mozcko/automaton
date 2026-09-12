import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "./mocks.js";
import {
  DEFAULT_DAILY_TARGET_CENTS,
  GENERATION_STATE_KV,
  TRADING_HALTED_KV,
  evaluateGenerationDay,
  readGenerationState,
  startNextGeneration,
} from "../trading/generation.js";
import type { AutomatonDatabase } from "../types.js";

describe("trading generation controller", () => {
  let db: AutomatonDatabase;
  const dayOne = new Date("2026-01-01T12:00:00.000Z");
  const dayTwo = new Date("2026-01-02T12:00:00.000Z");

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("initializes the first generation with a $2.00 gross-profit target", () => {
    const result = evaluateGenerationDay(db, 500, dayOne);
    expect(result.outcome).toBe("initialized");
    expect(readGenerationState(db)).toMatchObject({
      generation: 1,
      targetCents: DEFAULT_DAILY_TARGET_CENTS,
      startPnlCents: 500,
      status: "active",
    });
  });

  it("raises the next daily target by $0.20 after success", () => {
    evaluateGenerationDay(db, 0, dayOne);
    const result = evaluateGenerationDay(db, 200, dayTwo);
    expect(result.outcome).toBe("success");
    if (result.outcome === "success") {
      expect(result.grossProfitCents).toBe(200);
      expect(result.state.targetCents).toBe(220);
    }
    expect(db.getKV(TRADING_HALTED_KV)).toBeUndefined();
  });

  it("uses an operator-configured starting target and raise", () => {
    const policy = { dailyProfitTargetCents: 350, dailyProfitRaiseCents: 45 };
    evaluateGenerationDay(db, 0, dayOne, policy);
    const result = evaluateGenerationDay(db, 350, dayTwo, policy);
    expect(result.outcome).toBe("success");
    if (result.outcome === "success") {
      expect(result.state.targetCents).toBe(395);
    }
  });

  it("halts trading and queues evolution after a missed target", () => {
    evaluateGenerationDay(db, 0, dayOne);
    const result = evaluateGenerationDay(db, 199, dayTwo);
    expect(result.outcome).toBe("failure");
    expect(db.getKV(TRADING_HALTED_KV)).toBe("daily_profit_target_missed");
    expect(db.getKV("requested_wake_mode")).toBe("evolution");
    expect(readGenerationState(db)?.status).toBe("awaiting_evolution");
  });

  it("does not evaluate the same UTC day twice", () => {
    evaluateGenerationDay(db, 0, dayOne);
    expect(evaluateGenerationDay(db, 100, dayOne).outcome).toBe("pending");
    expect(readGenerationState(db)?.targetCents).toBe(200);
  });

  it("starts the successor with the retained target and a fresh PnL baseline", () => {
    evaluateGenerationDay(db, 0, dayOne);
    evaluateGenerationDay(db, 0, dayTwo);
    const next = startNextGeneration(db, 50, dayTwo);
    expect(next).toMatchObject({
      generation: 2,
      targetCents: 200,
      startPnlCents: 50,
      status: "active",
    });
    expect(db.getKV(TRADING_HALTED_KV)).toBeUndefined();
    expect(JSON.parse(db.getKV(GENERATION_STATE_KV)!).generation).toBe(2);
  });
});
