/**
 * Trading Cadence (Step 1: cognitive token burn optimization)
 *
 * Pure decision logic for the dynamic heartbeat "throttle" and wake-mode
 * selection. No I/O here so it stays deterministic and cheap to test.
 *
 * The market sentinel heartbeat task persists MarketSnapshot rows (price +
 * timestamp) WITHOUT ever calling inference. This module reads those
 * snapshots to decide:
 *   - how long the agent should sleep between routine trading wakes, and
 *   - whether the current volatility warrants an immediate short-interval wake.
 */

import type { MarketSnapshot, TradingCadenceConfig, WakeMode } from "../types.js";
import { DEFAULT_TRADING_CADENCE_CONFIG } from "../types.js";

/** Merge user settings with safe defaults and clamp invalid values. */
export function normalizeTradingCadence(
  input?: Partial<TradingCadenceConfig> | null,
): TradingCadenceConfig {
  const merged = { ...DEFAULT_TRADING_CADENCE_CONFIG, ...(input ?? {}) };
  const positive = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : fallback;

  const minIntervalMs = positive(
    merged.minIntervalMs,
    DEFAULT_TRADING_CADENCE_CONFIG.minIntervalMs,
  );
  const requestedMax = positive(
    merged.maxIntervalMs,
    DEFAULT_TRADING_CADENCE_CONFIG.maxIntervalMs,
  );

  return {
    symbol:
      typeof merged.symbol === "string" && merged.symbol.trim()
        ? merged.symbol.trim()
        : DEFAULT_TRADING_CADENCE_CONFIG.symbol,
    minIntervalMs,
    maxIntervalMs: Math.max(minIntervalMs, requestedMax),
    volatilityThresholdPct: positive(
      merged.volatilityThresholdPct,
      DEFAULT_TRADING_CADENCE_CONFIG.volatilityThresholdPct,
    ),
    lookbackMs: positive(
      merged.lookbackMs,
      DEFAULT_TRADING_CADENCE_CONFIG.lookbackMs,
    ),
    evolutionIntervalMs: positive(
      merged.evolutionIntervalMs,
      DEFAULT_TRADING_CADENCE_CONFIG.evolutionIntervalMs,
    ),
  };
}

export interface VolatilityAssessment {
  /** Absolute percentage move over the lookback window. */
  movePct: number;
  /** True when movePct >= volatilityThresholdPct. */
  volatile: boolean;
  /** Number of snapshots considered. */
  sampleCount: number;
}

/**
 * Measure absolute percentage price movement across the snapshots that fall
 * within `lookbackMs` of the most recent snapshot.
 *
 * Returns movePct=0 / volatile=false when there is insufficient data — a flat
 * assessment is the safe default (long sleep, no wasted inference).
 */
export function assessVolatility(
  snapshots: MarketSnapshot[],
  config: TradingCadenceConfig = DEFAULT_TRADING_CADENCE_CONFIG,
  now: number = Date.now(),
): VolatilityAssessment {
  if (!snapshots || snapshots.length < 2) {
    return { movePct: 0, volatile: false, sampleCount: snapshots?.length ?? 0 };
  }

  // Sort oldest → newest defensively; callers may pass either order.
  const sorted = [...snapshots].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  const latest = sorted[sorted.length - 1];
  const cutoff = now - config.lookbackMs;

  // Consider only snapshots inside the lookback window. An old sample must not
  // turn one fresh observation into a false volatility alert.
  const window = sorted.filter(
    (s) => new Date(s.timestamp).getTime() >= cutoff,
  );
  if (window.length < 2) {
    return { movePct: 0, volatile: false, sampleCount: window.length };
  }
  const considered = window;

  let min = Infinity;
  let max = -Infinity;
  for (const s of considered) {
    if (!Number.isFinite(s.price) || s.price <= 0) continue;
    if (s.price < min) min = s.price;
    if (s.price > max) max = s.price;
  }

  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0) {
    return { movePct: 0, volatile: false, sampleCount: considered.length };
  }

  // Percentage move measured against the latest price so it reflects the
  // magnitude of the swing relative to current market value.
  const reference = Number.isFinite(latest.price) && latest.price > 0 ? latest.price : min;
  const movePct = ((max - min) / reference) * 100;

  return {
    movePct,
    volatile: movePct >= config.volatilityThresholdPct,
    sampleCount: considered.length,
  };
}

export interface CadenceDecision {
  /** ms until the next routine trading wake. */
  sleepMs: number;
  /** Volatility assessment behind the decision. */
  assessment: VolatilityAssessment;
}

/**
 * Decide the next trading sleep interval from a volatility assessment.
 * Volatile → minIntervalMs. Flat → maxIntervalMs.
 */
export function decideTradingSleep(
  assessment: VolatilityAssessment,
  config: TradingCadenceConfig = DEFAULT_TRADING_CADENCE_CONFIG,
): CadenceDecision {
  const sleepMs = assessment.volatile ? config.minIntervalMs : config.maxIntervalMs;
  return { sleepMs, assessment };
}

/**
 * Decide whether the current wake should run the evolution (slow) loop.
 * Evolution runs at most once per `evolutionIntervalMs`.
 *
 * @param lastEvolutionAtIso ISO timestamp of the last evolution run, or null.
 */
export function shouldRunEvolution(
  lastEvolutionAtIso: string | null | undefined,
  config: TradingCadenceConfig = DEFAULT_TRADING_CADENCE_CONFIG,
  now: number = Date.now(),
): boolean {
  if (!lastEvolutionAtIso) return true;
  const last = new Date(lastEvolutionAtIso).getTime();
  if (Number.isNaN(last)) return true;
  return now - last >= config.evolutionIntervalMs;
}

/**
 * Resolve the effective wake mode for this cycle.
 *
 * An explicit "evolution" request wins only if the evolution cooldown has
 * elapsed; otherwise we fall back to the routine trading loop. This prevents
 * scheduler retries / restarts from firing multiple expensive planning calls.
 */
export function resolveWakeMode(params: {
  requestedMode?: WakeMode | null;
  lastEvolutionAtIso?: string | null;
  config?: TradingCadenceConfig;
  now?: number;
}): WakeMode {
  const config = params.config ?? DEFAULT_TRADING_CADENCE_CONFIG;
  const now = params.now ?? Date.now();
  if (
    params.requestedMode === "evolution" &&
    shouldRunEvolution(params.lastEvolutionAtIso, config, now)
  ) {
    return "evolution";
  }
  return "trading";
}
