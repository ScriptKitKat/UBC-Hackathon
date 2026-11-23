import { describe, expect, it, vi } from "vitest";
import { cachedView, categoryKey, FILTERS, PREFETCH_CATEGORIES, refreshHome } from "./category";

describe("categoryKey", () => {
  it("uses the filter when it is not All", () => {
    expect(categoryKey("Crypto", "Sports")).toBe("Crypto");
    expect(categoryKey("Politics", undefined)).toBe("Politics");
  });

  it("uses the chip when the All filter is on", () => {
    expect(categoryKey("All", "Sports")).toBe("Sports");
    expect(categoryKey("All", undefined)).toBe("All");
  });
});

describe("cachedView", () => {
  it("returns the cached page so filter chips can switch without a fetch", () => {
    const all = { id: "all" };
    const crypto = { id: "crypto" };
    const cache = { All: all, Crypto: crypto };
    expect(cachedView(cache, categoryKey("All", undefined))).toBe(all);
    expect(cachedView(cache, categoryKey("Crypto", undefined))).toBe(crypto);
    expect(cachedView(cache, categoryKey("Sports", undefined))).toBeUndefined();
  });

  it("covers the Moving now chips that should be prefetched", () => {
    expect(FILTERS).toEqual(["All", "Crypto", "Sports", "Politics"]);
    expect(PREFETCH_CATEGORIES).toEqual(["Crypto", "Sports", "Politics", "Economy"]);
  });
});

describe("refreshHome", () => {
  it("finishes the active category before prefetching other categories", async () => {
    const active = Promise.withResolvers<undefined>();
    const prefetch = vi.fn<(name: string) => Promise<void>>().mockResolvedValue(undefined);
    const done = refreshHome(() => active.promise, prefetch, () => true);
    expect(prefetch).not.toHaveBeenCalled();
    active.resolve(undefined);
    await done;
    expect(prefetch.mock.calls.map(([name]) => name)).toEqual(PREFETCH_CATEGORIES);
  });

  it("skips prefetch if the active category changed during the refresh", async () => {
    const active = Promise.withResolvers<undefined>();
    const prefetch = vi.fn(() => Promise.resolve());
    let activeCategory = "All";
    const done = refreshHome(() => active.promise, prefetch, () => activeCategory === "All");
    activeCategory = "Sports";
    active.resolve(undefined);
    await done;
    expect(prefetch).not.toHaveBeenCalled();
  });
});
