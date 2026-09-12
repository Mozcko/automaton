import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("loadConfig", () => {
  it("uses an empty sandbox id when SANDBOX_ID is absent", () => {
    process.env.AUTOMATON_NAME = "data-crab-test";
    process.env.CREATOR_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
    delete process.env.SANDBOX_ID;

    const config = loadConfig();

    expect(config).not.toBeNull();
    expect(config!.sandboxId).toBe("");
  });
});
