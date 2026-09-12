/**
 * Resource Monitor
 *
 * Continuously monitors the automaton's resources and triggers
 * survival mode transitions when needed.
 */

import type {
  AutomatonConfig,
  AutomatonDatabase,
  ConwayClient,
  AutomatonIdentity,
  FinancialState,
  SurvivalTier,
} from "../types.js";
import { getSurvivalTier, formatCredits } from "../conway/credits.js";
import { getUsdcBalance } from "../conway/x402.js";

export interface ResourceStatus {
  financial: FinancialState;
  tier: SurvivalTier;
  previousTier: SurvivalTier | null;
  tierChanged: boolean;
  sandboxHealthy: boolean;
  diagnostics: ResourceDiagnostics;
}

export interface ResourceDiagnostics {
  creditsError?: string;
  usdcError?: string;
  sandboxError?: string;
}

/**
 * Check all resources and return current status.
 */
export async function checkResources(
  identity: AutomatonIdentity,
  conway: ConwayClient,
  db: AutomatonDatabase,
): Promise<ResourceStatus> {
  const diagnostics: ResourceDiagnostics = {};

  let creditsCents = 0;
  let usdcBalance = 0;

  try {
    const { ExchangeAdapter } = await import("../exchange/adapter.js");
    const adapter = new ExchangeAdapter();
    const balance = await adapter.getBalance();
    
    const usdt = (balance.total as any)["USDT"] || 0;
    const mxn = (balance.total as any)["MXN"] || 0;
    const btc = (balance.total as any)["BTC"] || 0;
    const totalUsdEquity = usdt + (mxn * 0.05) + (btc * 60000);
    
    creditsCents = Math.floor(totalUsdEquity * 100);
    usdcBalance = totalUsdEquity;
  } catch (error) {
    diagnostics.creditsError = error instanceof Error ? error.message : String(error);
    if (process.env.AUTOMATON_CREDITS_BALANCE) {
       creditsCents = Number(process.env.AUTOMATON_CREDITS_BALANCE);
    }
  }

  let sandboxHealthy = true;

  const financial: FinancialState = {
    creditsCents,
    usdcBalance,
    lastChecked: new Date().toISOString(),
  };

  const tier = getSurvivalTier(creditsCents);
  const prevTierStr = db.getKV("current_tier");
  const previousTier = (prevTierStr as SurvivalTier) || null;
  const tierChanged = previousTier !== null && previousTier !== tier;

  // Store current tier
  db.setKV("current_tier", tier);

  // Store financial state
  db.setKV("financial_state", JSON.stringify(financial));

  return {
    financial,
    tier,
    previousTier,
    tierChanged,
    sandboxHealthy,
    diagnostics,
  };
}

/**
 * Generate a human-readable resource report.
 */
export function formatResourceReport(status: ResourceStatus): string {
  const diagnostics = status.diagnostics || {};
  const creditsLine = diagnostics.creditsError
    ? `Credits: unknown (${diagnostics.creditsError})`
    : `Credits: ${formatCredits(status.financial.creditsCents)}`;
  const usdcLine = diagnostics.usdcError
    ? `USDC: unknown (${diagnostics.usdcError})`
    : `USDC: ${status.financial.usdcBalance.toFixed(6)}`;
  const sandboxLine = diagnostics.sandboxError
    ? `Sandbox: UNHEALTHY (${diagnostics.sandboxError})`
    : `Sandbox: ${status.sandboxHealthy ? "healthy" : "UNHEALTHY"}`;

  const lines = [
    `=== RESOURCE STATUS ===`,
    creditsLine,
    usdcLine,
    `Tier: ${status.tier}${status.tierChanged ? ` (changed from ${status.previousTier})` : ""}`,
    sandboxLine,
    `Checked: ${status.financial.lastChecked}`,
    `========================`,
  ];
  return lines.join("\n");
}

function toDiagnosticMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}
