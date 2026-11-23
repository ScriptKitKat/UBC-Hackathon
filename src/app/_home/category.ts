export const CHIP_CATEGORIES = ["Crypto", "Sports", "Politics", "Economy"] as const;
export const FILTERS = ["All", "Crypto", "Sports", "Politics"] as const;
export const PREFETCH_CATEGORIES = ["Crypto", "Sports", "Politics", "Economy"] as const;

export function categoryKey(filter: string, chip: string | undefined): string {
  if (filter !== "All") return filter;
  return chip ?? "All";
}

export function cachedView<T>(cache: Readonly<Record<string, T>>, key: string): T | undefined {
  return cache[key];
}

export async function refreshHome(
  refreshActive: () => Promise<void>,
  prefetchCategory: (category: string) => Promise<void>,
  shouldPrefetch: () => boolean,
): Promise<void> {
  await refreshActive();
  if (shouldPrefetch()) await Promise.allSettled(PREFETCH_CATEGORIES.map(prefetchCategory));
}
