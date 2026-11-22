import { describe, expect, it } from "vitest";
import { createGeminiMarketsClient } from "@/features/markets";
import activeFixture from "./fixtures/events-active.json";
import emptyFixture from "./fixtures/events-empty.json";
import fedFixture from "./fixtures/events-fed.json";
import { profileNews } from "./keywords";
import { matchNews, type NewsItem } from "./index";

function fixtureFor(search: string | null): unknown {
  const term = search?.toLowerCase() ?? "";
  if (term === "fed") {
    return fedFixture;
  }
  if (term === "btc") {
    return activeFixture;
  }
  return emptyFixture;
}

function buildClient(responder: (search: string | null) => unknown = fixtureFor) {
  let now = 0;
  const fakeFetch = ((input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return Promise.resolve(new Response(JSON.stringify(responder(url.searchParams.get("search")))));
  }) as typeof fetch;
  return createGeminiMarketsClient({
    baseUrl: "https://example.test",
    fetch: fakeFetch,
    clock: {
      nowMs: () => now,
      sleep: (ms) => {
        now += ms;
        return Promise.resolve();
      },
    },
  });
}

const news = (text: string): NewsItem => ({ id: "n1", text, postedAt: new Date("2026-11-17T12:00:00Z") });

describe("profileNews", () => {
  it("lowercases, drops stopwords and applies aliases", () => {
    const profile = profileNews("Federal Reserve chair Powell says the rate cut is coming");
    expect(profile.aliasKeywords).toEqual(new Set(["fed"]));
    expect(profile.searchKeywords[0]).toBe("fed");
    expect(profile.tokens.has("the")).toBe(false);
    expect(profile.tokens.has("federal")).toBe(true);
  });

  it("maps bitcoin to btc and is deterministic", () => {
    const first = profileNews("Bitcoin surges past records");
    expect(first.searchKeywords[0]).toBe("btc");
    expect(profileNews("Bitcoin surges past records")).toEqual(first);
  });

  it("bounds the number of search keywords", () => {
    expect(profileNews("alpha bravo charlie delta echo foxtrot golf").searchKeywords).toHaveLength(3);
  });
});

describe("matchNews", () => {
  it("matches a Fed post to a GEMI-FED261211 contract", async () => {
    const result = await matchNews(
      news("Powell signals the Fed will cut rates by 25bps at the December FOMC meeting"),
      { client: buildClient() },
    );
    if (result.kind !== "matched") {
      throw new Error(result.reason);
    }
    expect(result.best.contract.instrumentSymbol).toBe("GEMI-FED261211-CUT25");
    expect(result.best.contract.instrumentSymbol.startsWith("GEMI-FED261211-")).toBe(true);
    expect(result.score).toBe(result.best.score);
    expect(result.reasons.join(" ")).toContain("fed");
    expect(result.alternatives.length).toBeGreaterThan(0);
    expect(result.alternatives.every((alt) => alt.score <= result.score)).toBe(true);
  });

  it("returns only symbols that exist in the fetched markets", async () => {
    const result = await matchNews(news("Fed holds rates steady"), { client: buildClient() });
    const known = new Set(
      fedFixture.data.flatMap((event) => event.contracts.map((contract) => contract.instrumentSymbol)),
    );
    if (result.kind !== "matched") {
      throw new Error(result.reason);
    }
    for (const candidate of [result.best, ...result.alternatives]) {
      expect(known.has(candidate.contract.instrumentSymbol)).toBe(true);
    }
  });

  it("returns no-match with a reason for an unrelated post", async () => {
    const result = await matchNews(news("Local bakery wins croissant of the year award"), {
      client: buildClient(),
    });
    expect(result.kind).toBe("no-match");
    expect(result.kind === "no-match" && result.reason).toContain("No active markets found");
  });

  it("returns no-match when markets are found but irrelevant", async () => {
    const result = await matchNews(news("Sunny weekend ahead"), {
      client: buildClient(() => fedFixture),
    });
    expect(result).toEqual({
      kind: "no-match",
      reason: "No open contract is relevant enough to the post (searched: weekend, sunny, ahead).",
    });
  });

  it("reports search failures in the reason", async () => {
    const client = createGeminiMarketsClient({
      baseUrl: "https://example.test",
      fetch: (() => Promise.resolve(new Response("", { status: 503 }))),
    });
    const result = await matchNews(news("Fed cut"), { client });
    expect(result).toEqual({ kind: "no-match", reason: "Market search failed (HTTP 503)." });
  });

  it("keeps fetch credentials out of the match result", async () => {
    const client = createGeminiMarketsClient({
      baseUrl: "https://example.test/RPC_SECRET_SENTINEL",
      fetch: (url) => Promise.reject(new Error(typeof url === "string" ? url : "RPC_SECRET_SENTINEL")),
    });
    expect(await matchNews(news("Fed"), { client })).toEqual({
      kind: "no-match", reason: "Market search failed (network unavailable).",
    });
  });

  it("makes at most three search calls", async () => {
    const searches: (string | null)[] = [];
    const client = buildClient((search) => {
      searches.push(search);
      return emptyFixture;
    });
    await matchNews(news("alpha bravo charlie delta echo foxtrot golf"), { client });
    expect(searches).toHaveLength(3);
  });

  it("is deterministic", async () => {
    const text = "Fed expected to cut rates in December";
    const a = await matchNews(news(text), { client: buildClient() });
    const b = await matchNews(news(text), { client: buildClient() });
    expect(a).toEqual(b);
  });
});
