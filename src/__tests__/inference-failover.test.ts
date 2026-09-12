import { afterEach, describe, expect, it, vi } from "vitest";
import { createInferenceClient } from "../conway/inference.js";

describe("main-loop inference failover", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back from DeepSeek to OpenAI after quota exhaustion", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ error: { code: "insufficient_quota" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "openai-response",
          model: "gpt-4.1-mini",
          choices: [{ message: { role: "assistant", content: "fallback worked" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const client = createInferenceClient({
      apiUrl: "https://api.conway.tech",
      apiKey: "conway-key",
      defaultModel: "deepseek-chat",
      maxTokens: 128,
      deepseekApiKey: "deepseek-key",
      openaiApiKey: "openai-key",
      getModelProvider: (model) =>
        model === "deepseek-chat" ? "deepseek" : "openai",
    });

    const response = await client.chat(
      [{ role: "user", content: "trade?" }],
      { model: "deepseek-chat", fallbackModels: ["gpt-4.1-mini"] },
    );

    expect(response.model).toBe("gpt-4.1-mini");
    expect(response.message.content).toBe("fallback worked");
    expect(fetchMock.mock.calls[0][0]).toContain("api.deepseek.com");
    expect(fetchMock.mock.calls[1][0]).toContain("api.openai.com");
  });
});
