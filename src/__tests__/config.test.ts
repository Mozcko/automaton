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

  it("permits a mock creator identity in local mode", () => {
    process.env.AUTOMATON_NAME = "data-crab-local";
    process.env.LOCAL_MODE = "true";
    delete process.env.CREATOR_ADDRESS;

    const config = loadConfig();

    expect(config).not.toBeNull();
    expect(config!.localMode).toBe(true);
    expect(config!.creatorAddress).toBe("local-operator");
  });
});
