import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "./mocks.js";
import {
  EXCHANGE_PNL_BASELINE_KV,
  getPnlFromEquity,
} from "../exchange/adapter.js";
import type { AutomatonDatabase } from "../types.js";

describe("exchange PnL baseline", () => {
  let db: AutomatonDatabase;
  const originalBaseline = process.env.PNL_BASELINE_USD;

  beforeEach(() => {
    db = createTestDb();
    delete process.env.PNL_BASELINE_USD;
  });

  afterEach(() => {
    db.close();
    if (originalBaseline === undefined) delete process.env.PNL_BASELINE_USD;
    else process.env.PNL_BASELINE_USD = originalBaseline;
  });

  it("starts a pre-funded deployment at zero PnL", () => {
    expect(getPnlFromEquity(58.69, db)).toBe(0);
    expect(db.getKV(EXCHANGE_PNL_BASELINE_KV)).toBe("58.69");
  });

  it("reports only the movement since the persisted live-equity baseline", () => {
    getPnlFromEquity(58.69, db);
    expect(getPnlFromEquity(60.89, db)).toBeCloseTo(2.2);
  });

  it("uses PNL_BASELINE_USD only when explicitly configured", () => {
    process.env.PNL_BASELINE_USD = "50";
    expect(getPnlFromEquity(58.69, db)).toBeCloseTo(8.69);
    expect(db.getKV(EXCHANGE_PNL_BASELINE_KV)).toBe("50");
  });
});
