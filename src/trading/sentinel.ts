/**
 * Market Sentinel storage helpers.
 *
 * The sentinel heartbeat task records a small ring buffer of recent price
 * snapshots in KV. This is deliberately cheap: NO inference, NO ReAct loop.
 * The agent loop later reads these snapshots to size its next sleep.
 */

import type { MarketSnapshot } from "../types.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("trading.sentinel");

export const MARKET_SNAPSHOTS_KV = "market_snapshots";
/** Cap the ring buffer so KV stays tiny. */
export const MAX_SNAPSHOTS = 60;

interface KVLike {
  getKV(key: string): string | undefined;
  setKV(key: string, value: string): void;
}

/** Read the persisted snapshot ring buffer (oldest → newest). */
export function readSnapshots(db: KVLike): MarketSnapshot[] {
  const raw = db.getKV(MARKET_SNAPSHOTS_KV);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is MarketSnapshot =>
        s && typeof s.price === "number" && typeof s.timestamp === "string",
    );
  } catch (err) {
    logger.warn(`Failed to parse market snapshots: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Append a snapshot to the ring buffer and persist it.
 * Trims to MAX_SNAPSHOTS (newest kept) and returns the new buffer.
 */
export function recordSnapshot(
  db: KVLike,
  snapshot: MarketSnapshot,
  maxSnapshots: number = MAX_SNAPSHOTS,
): MarketSnapshot[] {
  const existing = readSnapshots(db);
  const next = [...existing, snapshot].slice(-maxSnapshots);
  db.setKV(MARKET_SNAPSHOTS_KV, JSON.stringify(next));
  return next;
}
