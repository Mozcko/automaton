/**
 * Daily gross-PnL generation controller.
 *
 * This deliberately does not estimate API or hosting cost. A generation is
 * evaluated only on its exchange PnL delta over a completed UTC day.
 */

export const GENERATION_STATE_KV = "trading_generation_state";
export const TRADING_HALTED_KV = "trading_halted";
export const DEFAULT_DAILY_TARGET_CENTS = 200;
export const DAILY_TARGET_INCREMENT_CENTS = 20;

export interface GenerationState {
  generation: number;
  targetCents: number;
  day: string;
  startPnlCents: number;
  status: "active" | "awaiting_evolution";
  lastGrossProfitCents?: number;
}

export interface GenerationPolicy {
  dailyProfitTargetCents: number;
  dailyProfitRaiseCents: number;
}

const DEFAULT_POLICY: GenerationPolicy = {
  dailyProfitTargetCents: DEFAULT_DAILY_TARGET_CENTS,
  dailyProfitRaiseCents: DAILY_TARGET_INCREMENT_CENTS,
};

interface KVStore {
  getKV(key: string): string | undefined;
  setKV(key: string, value: string): void;
  deleteKV(key: string): void;
}

export type GenerationEvaluation =
  | { outcome: "initialized" | "pending"; state: GenerationState }
  | { outcome: "success" | "failure"; state: GenerationState; grossProfitCents: number };

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function readGenerationState(db: KVStore): GenerationState | undefined {
  const raw = db.getKV(GENERATION_STATE_KV);
  if (!raw) return undefined;
  try {
    const state = JSON.parse(raw) as GenerationState;
    if (
      Number.isInteger(state.generation) && state.generation > 0 &&
      Number.isFinite(state.targetCents) && state.targetCents > 0 &&
      typeof state.day === "string" &&
      Number.isFinite(state.startPnlCents) &&
      (state.status === "active" || state.status === "awaiting_evolution")
    ) {
      return state;
    }
  } catch {
    // A corrupt generation record must not resume live trading.
    db.setKV(TRADING_HALTED_KV, "corrupt_generation_state");
  }
  return undefined;
}

export function initializeGeneration(
  db: KVStore,
  pnlCents: number,
  now: Date = new Date(),
  policy: GenerationPolicy = DEFAULT_POLICY,
): GenerationState {
  const state: GenerationState = {
    generation: 1,
    targetCents: policy.dailyProfitTargetCents,
    day: utcDay(now),
    startPnlCents: pnlCents,
    status: "active",
  };
  db.setKV(GENERATION_STATE_KV, JSON.stringify(state));
  return state;
}

/** Evaluate a completed UTC day once, from the PnL baseline stored at its start. */
export function evaluateGenerationDay(
  db: KVStore,
  pnlCents: number,
  now: Date = new Date(),
  policy: GenerationPolicy = DEFAULT_POLICY,
): GenerationEvaluation {
  const today = utcDay(now);
  const existing = readGenerationState(db);
  if (!existing) {
    return { outcome: "initialized", state: initializeGeneration(db, pnlCents, now, policy) };
  }
  if (existing.status === "awaiting_evolution" || existing.day === today) {
    return { outcome: "pending", state: existing };
  }

  const grossProfitCents = pnlCents - existing.startPnlCents;
  if (grossProfitCents >= existing.targetCents) {
    const state: GenerationState = {
      ...existing,
      targetCents: existing.targetCents + policy.dailyProfitRaiseCents,
      day: today,
      startPnlCents: pnlCents,
      status: "active",
      lastGrossProfitCents: grossProfitCents,
    };
    db.setKV(GENERATION_STATE_KV, JSON.stringify(state));
    return { outcome: "success", state, grossProfitCents };
  }

  const state: GenerationState = {
    ...existing,
    status: "awaiting_evolution",
    lastGrossProfitCents: grossProfitCents,
  };
  db.setKV(GENERATION_STATE_KV, JSON.stringify(state));
  db.setKV(TRADING_HALTED_KV, "daily_profit_target_missed");
  db.setKV("requested_wake_mode", "evolution");
  return { outcome: "failure", state, grossProfitCents };
}

/**
 * Start the next generation after its evolution review has prepared a change.
 * The raised target is retained: improvements must satisfy the current bar.
 */
export function startNextGeneration(
  db: KVStore,
  pnlCents: number,
  now: Date = new Date(),
  policy: GenerationPolicy = DEFAULT_POLICY,
): GenerationState {
  const previous = readGenerationState(db) ?? initializeGeneration(db, pnlCents, now, policy);
  const state: GenerationState = {
    generation: previous.generation + 1,
    targetCents: previous.targetCents,
    day: utcDay(now),
    startPnlCents: pnlCents,
    status: "active",
  };
  db.setKV(GENERATION_STATE_KV, JSON.stringify(state));
  db.deleteKV(TRADING_HALTED_KV);
  return state;
}
