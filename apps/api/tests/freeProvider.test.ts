// Unit tests for the keyless free AI provider. Network is mocked — no real
// HTTP calls. Env vars are flipped per case and restored afterwards.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FreeUnavailable,
  buildFreePrompt,
  isFreeEnabled,
  makeFreeProvider,
} from "../src/providers/free.js";

const MANAGED = ["FREE_AI_ENABLED", "PROVIDER_DISABLED"];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of MANAGED) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.unstubAllGlobals();
});

afterEach(() => {
  for (const k of MANAGED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

function streamAll(p: ReturnType<typeof makeFreeProvider>, system?: string) {
  const tokens: string[] = [];
  return p
    .streamChat({
      system,
      messages: [{ role: "user", content: "hello" }],
      signal: new AbortController().signal,
      onToken: (t) => tokens.push(t),
    })
    .then((r) => ({ text: tokens.join(""), result: r }));
}

describe("isFreeEnabled", () => {
  it("is on by default", () => {
    expect(isFreeEnabled()).toBe(true);
  });
  it("respects FREE_AI_ENABLED=false", () => {
    process.env.FREE_AI_ENABLED = "false";
    expect(isFreeEnabled()).toBe(false);
  });
  it("respects the kill switch", () => {
    process.env.PROVIDER_DISABLED = "free";
    expect(isFreeEnabled()).toBe(false);
  });
});

describe("buildFreePrompt", () => {
  it("folds system + conversation into one prompt", () => {
    const p = buildFreePrompt("Be brief.", [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "bye" },
    ]);
    expect(p).toContain("Be brief.");
    expect(p).toContain("User: hi");
    expect(p).toContain("Assistant: hello");
    expect(p).toContain("User: bye");
    expect(p.endsWith("Assistant:")).toBe(true);
  });
  it("caps very long prompts", () => {
    const big = "x".repeat(50_000);
    const p = buildFreePrompt(undefined, [{ role: "user", content: big }]);
    expect(p.length).toBeLessThanOrEqual(6000);
  });
});

describe("makeFreeProvider", () => {
  it("streams a real reply word by word", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Assalam-o-Alaikum! How can I help?", { status: 200 })),
    );
    const { text, result } = await streamAll(makeFreeProvider());
    expect(text).toBe("Assalam-o-Alaikum! How can I help?");
    expect(result.outputTokens).toBeGreaterThan(0);
    expect(result.inputTokens).toBeGreaterThan(0);
  });

  it("throws FreeUnavailable on HTTP errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 429 })));
    await expect(streamAll(makeFreeProvider())).rejects.toThrow(FreeUnavailable);
  });

  it("throws FreeUnavailable on network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    await expect(streamAll(makeFreeProvider())).rejects.toThrow(FreeUnavailable);
  });

  it("throws FreeUnavailable on empty replies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("   ", { status: 200 })));
    await expect(streamAll(makeFreeProvider())).rejects.toThrow(FreeUnavailable);
  });

  it("throws FreeUnavailable when disabled", async () => {
    process.env.FREE_AI_ENABLED = "false";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(streamAll(makeFreeProvider())).rejects.toThrow(FreeUnavailable);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends private=true so replies stay out of the public feed", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await streamAll(makeFreeProvider());
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("private=true");
    expect(url.startsWith("https://text.pollinations.ai/")).toBe(true);
  });

  it("reports id 'free'", () => {
    expect(makeFreeProvider().id).toBe("free");
  });
});
