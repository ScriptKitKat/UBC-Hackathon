"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { isXUrl } from "@/shared";
import type { HomeView } from "@/shared";
import { usePolling } from "../_desk/use-polling";
import { loadHome, loadSparklines, matchQuery } from "../_shell/api";
import { ChevronIcon, RefreshIcon, SubmitIcon } from "../_shell/icons";
import { CHIP_CATEGORIES, FILTERS, categoryKey, refreshHome } from "./category";
import { useWatchlist } from "../_watchlist/use-watchlist";
import { MarketCard, MarketCardGrid, MarketCardSkeletonGrid } from "../_market-card/market-card";
import { catalogCardModel } from "../_market-card/model";
import { useViewMode } from "../_research/use-view-mode";
import styles from "./home.module.css";

const POLL_MS = 30_000;

const HERO_LOGOS: readonly { readonly src: string; readonly size: number; readonly rotate: number; readonly position: { readonly left?: string; readonly right?: string; readonly top: string } }[] = [
  { src: "/hero/btc.avif", size: 110, rotate: -14, position: { left: "4%", top: "24%" } },
  { src: "/hero/sol.avif", size: 78, rotate: 10, position: { left: "13%", top: "60%" } },
  { src: "/hero/xrp.avif", size: 56, rotate: 18, position: { right: "14%", top: "6%" } },
  { src: "/hero/basketball.avif", size: 96, rotate: 12, position: { right: "3%", top: "22%" } },
  { src: "/hero/eth.avif", size: 70, rotate: -8, position: { right: "10%", top: "62%" } },
];

function applySparklines(view: HomeView, updates: Readonly<Record<string, { readonly sparkline: readonly number[]; readonly changePercent: number | null }>>): HomeView {
  const markets = view.markets.map((card) => {
    const update = updates[card.instrumentSymbol];
    if (update === undefined) return card;
    return { ...card, sparkline: [...update.sparkline], changePercent: update.changePercent };
  });
  const sorted = [...markets].sort((left, right) => {
    const leftMove = left.changePercent === null ? -1 : Math.abs(left.changePercent);
    const rightMove = right.changePercent === null ? -1 : Math.abs(right.changePercent);
    return rightMove - leftMove;
  });
  return { ...view, markets: sorted };
}

async function fillSparklines(view: HomeView): Promise<HomeView> {
  const symbols = view.markets.filter((card) => card.sparkline.length < 2).map((card) => card.instrumentSymbol);
  if (symbols.length === 0) return view;
  const updates = await loadSparklines(symbols);
  if (Object.keys(updates).length === 0) return view;
  return applySparklines(view, updates);
}

export function HomePage({ initialView }: { readonly initialView?: HomeView } = {}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [chip, setChip] = useState<string | undefined>(undefined);
  const [filter, setFilter] = useState("All");
  const [view, setView] = useState<HomeView | undefined>(initialView);
  const [cache, setCache] = useState<Readonly<Record<string, HomeView>>>(initialView === undefined ? {} : { All: initialView });
  const [error, setError] = useState<string | null>(null);
  const [matchMessage, setMatchMessage] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const category = filter === "All" ? chip : filter;
  const activeKey = categoryKey(filter, chip);
  const requestKey = useRef(activeKey);
  requestKey.current = activeKey;

  const remember = (key: string, next: HomeView) => {
    setCache((current) => ({ ...current, [key]: next }));
    if (requestKey.current === key) setView(next);
  };

  const prefetchCategory = async (name: string) => {
    const prefetched = await loadHome({ sort: "moving", limit: 6, category: name });
    if (prefetched.kind !== "ok") return;
    setCache((current) => (current[name] === undefined ? { ...current, [name]: prefetched.view } : current));
    if (requestKey.current === name) setView(prefetched.view);
    const ready = await fillSparklines(prefetched.view);
    remember(name, ready);
  };

  usePolling(() => {
    const key = activeKey;
    const refreshActive = () => loadHome({ sort: "moving", limit: 6, ...(category ? { category } : {}) })
      .then(async (result) => {
        if (result.kind !== "ok") {
          if (requestKey.current === key) setError(result.message);
          return;
        }
        setError(null);
        remember(key, result.view);
        const filled = await fillSparklines(result.view);
        remember(key, filled);
      }).catch(() => {
        if (requestKey.current === key) setError("Live markets are unavailable right now.");
      });
    void refreshHome(refreshActive, prefetchCategory, () => key === "All" && requestKey.current === key);
  }, POLL_MS + tick);

  const markets = view?.markets ?? [];
  const watchlist = useWatchlist();
  const [mode] = useViewMode();
  const beginner = mode === "beginner";

  const selectFilter = (name: string) => {
    setFilter(name);
    setChip(undefined);
    const key = categoryKey(name, undefined);
    const cached = cache[key];
    setView(cached);
    setTick((value) => value + 1);
  };

  const selectChip = (name: string) => {
    const next = chip === name ? undefined : name;
    setFilter("All");
    setChip(next);
    const key = categoryKey("All", next);
    const cached = cache[key];
    if (cached !== undefined) setView(cached);
    else setView(undefined);
    setTick((value) => value + 1);
  };

  const openMarkets = (text: string) => {
    router.push(text === "" ? "/markets" : `/markets?search=${encodeURIComponent(text)}`);
  };

  const onSearch = () => {
    const text = search.trim();
    setMatchMessage(null);
    if (isXUrl(text)) {
      void matchQuery(text).then((result) => {
        if ("error" in result) {
          setMatchMessage(result.error);
          return;
        }
        if (result.kind === "matched") {
          openMarkets(result.market.eventTitle);
        } else {
          setMatchMessage(result.reason);
        }
      });
      return;
    }
    openMarkets(text);
  };

  return (
    <div className={styles.page}>
      <section className={styles.ask} aria-label="Ask">
        <div className={styles.logos} aria-hidden="true">
          {HERO_LOGOS.map((logo) => (
            <img
              key={logo.src}
              className={styles.logo}
              src={logo.src}
              alt=""
              style={{ width: logo.size, height: logo.size, transform: `rotate(${String(logo.rotate)}deg)`, ...logo.position }}
            />
          ))}
        </div>
        <h1 className={styles.title}>What do you want to <span className={styles.script}>predict?</span></h1>
        <form className={styles.box} onSubmit={(event) => { event.preventDefault(); onSearch(); }}>
          <label htmlFor="ask" className={styles.hidden}>Ask about a market</label>
          <input id="ask" className={styles.field} value={search} placeholder="Explore different markets, or paste an X link…" onChange={(event) => { setSearch(event.target.value); }} />
          <div className={styles.tools}>
            <button type="submit" className={styles.submit} aria-label="Search"><SubmitIcon /></button>
          </div>
        </form>
        {matchMessage ? <p className={styles.status}>{matchMessage}</p> : null}
        <div className={styles.chips}>
          {CHIP_CATEGORIES.map((name) => (
            <button
              key={name}
              type="button"
              className={styles.chip}
              aria-pressed={chip === name && filter === "All"}
              onClick={() => { selectChip(name); }}
            >
              {name}
            </button>
          ))}
          <button type="button" className={styles.refresh} aria-label="Refresh markets" onClick={() => { setTick((value) => value + 1); }}>
            <RefreshIcon />
          </button>
        </div>
      </section>

      <section className={styles.moving} aria-label="Moving now">
        <div className={styles.movingHead}>
          <h2 className={styles.movingTitle}>Moving now</h2>
          <div className={styles.filters}>
            {FILTERS.map((name) => (
              <button
                key={name}
                type="button"
                className={styles.filter}
                aria-pressed={filter === name}
                onClick={() => { selectFilter(name); }}
              >
                {name}
              </button>
            ))}
            <Link href="/markets" className={styles.browseLink}>Browse all <ChevronIcon /></Link>
          </div>
        </div>
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        {view?.stale === true ? <p className={styles.empty} role="status">Showing recent markets while Gemini cools down.</p> : null}
        {error === null && view === undefined ? (
          <>
            <p className={styles.empty}>Loading live markets…</p>
            <MarketCardSkeletonGrid count={6} layout="six" />
          </>
        ) : null}
        {error === null && view !== undefined && markets.length === 0 ? <p className={styles.empty}>No live markets right now.</p> : null}
        {markets.length > 0 ? (
          <MarketCardGrid layout="six">
            {markets.map((card) => (
              <MarketCard
                key={card.instrumentSymbol}
                model={catalogCardModel(card, beginner)}
                watch={{
                  pressed: watchlist.starred(card.eventTicker, card.instrumentSymbol),
                  onToggle: () => {
                    void watchlist.toggle({ eventTicker: card.eventTicker, instrumentSymbol: card.instrumentSymbol, yesCents: card.yesCents });
                  },
                }}
              />
            ))}
          </MarketCardGrid>
        ) : null}
        <div className={styles.footer}>
          <Link href="/markets" className={styles.browseAll}>Browse all markets</Link>
        </div>
      </section>
    </div>
  );
}
