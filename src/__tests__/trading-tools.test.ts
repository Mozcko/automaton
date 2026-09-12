import { afterEach, describe, expect, it, vi } from "vitest";
import { createBuiltinTools } from "../agent/tools.js";

describe("analyze_market", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts a ccxt-style symbol and sends Binance a REST-compatible symbol", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => Array.from(
        { length: 14 },
        (_, i) => [0, 0, 0, 0, String(1_000_000 + i), 0],
      ),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = createBuiltinTools("test-sandbox").find(
      (candidate) => candidate.name === "analyze_market",
    );
    const result = await tool!.execute(
      { symbol: "BTC/MXN", interval: "1m" },
      {} as never,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.binance.com/api/v3/klines?symbol=BTCMXN&interval=1m&limit=14",
    );
    expect(JSON.parse(result).currentPrice).toBe(1_000_013);
  });
});
