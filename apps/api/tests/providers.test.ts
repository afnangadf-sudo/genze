// Unit tests for the provider registry + router. No DB, no network —
// env vars are flipped per case and restored afterwards.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pickProvider } from "../src/providers/router.js";
import { getProviderStatus, providerDisabledSet } from "../src/providers/registry.js";

const MANAGED = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENAI_API_KEY",
  "KLING_API_KEY",
  "STEEL_API_KEY",
  "ELEVENLABS_API_KEY",
  "PROVIDER_DISABLED",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of MANAGED) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of MANAGED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("pickProvider", () => {
  it("routes PK chat to anthropic when configured", () => {
    process.env.ANTHROPIC_API_KEY = "x";
    process.env.OPENAI_API_KEY = "x";
    expect(pickProvider("PK", "chat")).toBe("anthropic");
  });

  it("normalizes lowercase country codes", () => {
    process.env.ANTHROPIC_API_KEY = "x";
    expect(pickProvider("pk", "chat")).toBe("anthropic");
  });

  it("returns null for AF when only anthropic is configured (not allowed there)", () => {
    process.env.ANTHROPIC_API_KEY = "x";
    expect(pickProvider("AF", "chat")).toBeNull();
  });

  it("routes AF chat to openai when configured", () => {
    process.env.OPENAI_API_KEY = "x";
    expect(pickProvider("AF", "chat")).toBe("openai");
  });

  it("returns null for unknown countries (fail closed)", () => {
    process.env.ANTHROPIC_API_KEY = "x";
    process.env.OPENAI_API_KEY = "x";
    expect(pickProvider("XX", "chat")).toBeNull();
    expect(pickProvider("", "chat")).toBeNull();
  });

  it("returns null on capability mismatch (kling cannot do chat)", () => {
    process.env.KLING_API_KEY = "x";
    expect(pickProvider("PK", "chat")).toBeNull();
    expect(pickProvider("US", "browser")).toBeNull();
  });

  it("excludes unconfigured providers", () => {
    process.env.OPENAI_API_KEY = "x"; // anthropic deliberately unset
    expect(pickProvider("PK", "chat")).toBe("openai");
  });

  it("kill switch (PROVIDER_DISABLED) removes the provider from routing", () => {
    process.env.ANTHROPIC_API_KEY = "x";
    process.env.OPENAI_API_KEY = "x";
    process.env.PROVIDER_DISABLED = "anthropic";
    expect(pickProvider("PK", "chat")).toBe("openai");
    expect(providerDisabledSet().has("anthropic")).toBe(true);
  });

  it("returns null when every allowed provider is disabled", () => {
    process.env.OPENAI_API_KEY = "x";
    process.env.PROVIDER_DISABLED = "openai";
    expect(pickProvider("AF", "chat")).toBeNull();
  });
});

describe("getProviderStatus", () => {
  it("reports configured/enabled flags without leaking secret values", () => {
    process.env.ANTHROPIC_API_KEY = "fake_test_key_for_leak_check_12345";
    process.env.PROVIDER_DISABLED = "kling";
    const statuses = getProviderStatus();
    expect(statuses).toHaveLength(6);
    const dump = JSON.stringify(statuses);
    expect(dump).not.toContain("sk-ant-super-secret-123");

    const anthropic = statuses.find((s) => s.id === "anthropic")!;
    expect(anthropic.configured).toBe(true);
    expect(anthropic.enabled).toBe(true);
    expect(anthropic.capabilities).toEqual(["chat"]);
    expect(anthropic.regions).toContain("PK");

    const kling = statuses.find((s) => s.id === "kling")!;
    expect(kling.enabled).toBe(false);
    expect(kling.capabilities).toEqual(["video"]);

    const openai = statuses.find((s) => s.id === "openai")!;
    expect(openai.configured).toBe(false);
  });
});
