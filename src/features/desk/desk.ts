import { executeApproved } from "@/features/execution";
import type { ExecutionError, PaperOrderTicket } from "@/features/execution";
import { CARD_CATEGORIES, createPostMatcher } from "@/features/grok";
import type { PostCandidate, PostInput } from "@/features/grok";
import { selectLlm } from "@/features/llm";
import { confirm, evaluate, evaluateResearch, marketPolicyRefusal, policyStateFromSpends, remainingBudget, restorePendingApproval } from "@/features/guardrails";
import type { ApprovedTrade, Decision, Policy, PolicyState } from "@/features/guardrails";
import { createMemoryHistory } from "@/features/history";
import type { HistoryStore } from "@/features/history";
import { createMemoryJournal, reconcileJournal } from "@/features/journal";
import type { Reconciliation, SpendEntry, SpendJournal } from "@/features/journal";
import type { UsdcLedger } from "@/features/ledger";
import { parseInstrumentSymbol } from "@/features/markets";
import type { Candle, CandleTimeframe, ContractLimits, GeminiMarketsClient, MarketContract, MarketEvent } from "@/features/markets";
import { matchNews } from "@/features/matcher";
import type { MatchCandidate, MatchResult, NewsItem } from "@/features/matcher";
import { aggregatePositions, buildPortfolio, fillsFromJournal, markFromContract, parsePortfolioRange, summarizeResearchSpend, todaysResearchSpendCents } from "@/features/positions";
import type { MarketMark, PortfolioMarket } from "@/features/positions";
import { instrumentSymbol, tweetTimeMs, usdCents } from "@/shared";
import type { FeedSettings } from "./config";
import { buildBriefLibrary } from "./brief-library";
import { buyDeepDive } from "./deep-dive";
import type { DeepDiveSettings } from "./deep-dive";
import { awaitingPaymentResult, createFeedOrders } from "./feed-orders";
import type { FeedOrder, FeedOrders } from "./feed-orders";
import { singleReconciliation } from "./reconciliation";
import { UNDELIVERED_RECOVERY_MS } from "./purchase-store";
import { yesCentsFromBrief } from "@/shared";
import type { BriefLibraryView } from "@/shared";
import type { StoredPurchase } from "./purchase-store";
import { capMatches, matchToContext } from "./match-store";
import type { StoredMatch } from "./match-store";
import type {
  DecisionLogEntry,
  DeepDiveResult,
  DeskSnapshot,
  FeedMarketView,
  FeedPositions,
  FeedMatch,
  FeedQuote,
  InstrumentSymbol,
  LedgerView,
  MarketView,
  MatchView,
  NewsView,
  Outcome,
  PendingView,
  PolicyView,
  PortfolioRange,
  PortfolioView,
  PositionsView,
  PositionStatus,
  PricePoint,
  ResearchPostContext,
  TradeIntent,
  TradeSource,
  ResearchBrief,
  UsdCents,
} from "@/shared";

const LOG_LIMIT = 1000;
const LOG_VIEW_LIMIT = 200;
const HISTORY_LIMIT = 90;
const MATCH_CACHE_LIMIT = 300;
const MATCH_CACHE_TTL_MS = 10 * 60 * 1000;
const PURCHASE_REUSE_MS = 15 * 60 * 1000;
const PURCHASE_LIMIT = 50;

type PendingTrade = Extract<Decision, { kind: "needs-approval" }>;

export interface DeskDeps {
  readonly policy: Policy;
  readonly markets: Pick<GeminiMarketsClient, "searchEvents" | "getEvent"> & Partial<Pick<GeminiMarketsClient, "candles">>;
  readonly ledger: UsdcLedger;
  readonly ledgerView: LedgerView;
  readonly feed: FeedSettings;
  readonly fetch?: typeof fetch;
  readonly now: () => Date;
  readonly idGen: () => string;
  readonly history?: HistoryStore;
  readonly initialLog?: readonly DecisionLogEntry[];
  readonly saveLog?: (log: readonly DecisionLogEntry[]) => Promise<void>;
  readonly journal?: SpendJournal;
  readonly feedOrders?: FeedOrders;
  readonly paymentInFlight?: (signature: string) => boolean;
  readonly research?: DeepDiveSettings;
  readonly initialPurchases?: readonly StoredPurchase[];
  readonly savePurchases?: (purchases: readonly StoredPurchase[]) => Promise<void>;
  readonly initialMatches?: readonly StoredMatch[];
  readonly saveMatches?: (matches: readonly StoredMatch[]) => Promise<void>;
}

export interface FeedBuyRequest {
  readonly clientOrderId: string;
  readonly instrumentSymbol: string;
  readonly outcome: Outcome;
  readonly notionalCents: number;
  readonly seenPriceCents?: number;
}

export interface ProposeRequest {
  readonly instrumentSymbol: string;
  readonly outcome: Outcome;
  readonly notionalCents: number;
  readonly source: TradeSource;
  readonly senderId: string;
  readonly seenPriceCents?: number;
  readonly requireApproval?: boolean;
}

export type ConfirmResult =
  | { readonly ok: true; readonly entry: DecisionLogEntry }
  | { readonly ok: false; readonly error: "unknown-intent" | "unauthorized-approver" };

export interface Desk {
  readonly submitNews: (news: NewsItem) => Promise<MatchView>;
  readonly matchPost: (post: PostInput) => Promise<FeedMatch>;
  readonly isCardFor: (postId: string, symbol: string) => Promise<boolean>;
  readonly quote: (symbol: string) => Promise<FeedQuote | undefined>;
  readonly postContextFor: (symbol: string) => Promise<ResearchPostContext | undefined>;
  readonly matchedPostsFor: (symbol: string) => Promise<readonly ResearchPostContext[]>;
  readonly peekResearchBriefs: (symbol: string) => { readonly current: StoredPurchase | null; readonly previous: StoredPurchase | null };
  readonly listBriefLibrary: () => Promise<BriefLibraryView>;
  readonly getFeedPositions: () => Promise<FeedPositions>;
  readonly getPositions: () => Promise<PositionsView>;
  readonly getPortfolio: (range?: PortfolioRange) => Promise<PortfolioView>;
  readonly buyDeepDive: (symbol: string) => Promise<DeepDiveResult>;
  readonly reconcile: () => Promise<Reconciliation>;
  readonly feedOrder: (clientOrderId: string) => Promise<DecisionLogEntry> | undefined;
  readonly buyFromFeed: (request: FeedBuyRequest) => Promise<DecisionLogEntry>;
  readonly confirmFromFeed: (intentId: string) => Promise<ConfirmResult>;
  readonly proposeTrade: (request: ProposeRequest) => Promise<DecisionLogEntry>;
  readonly confirmPending: (intentId: string, approverId: string) => Promise<ConfirmResult>;
  readonly rejectPending: (intentId: string, approverId: string) => Promise<ConfirmResult>;
  readonly setKillSwitch: (on: boolean) => void;
  readonly getSnapshot: () => Promise<DeskSnapshot>;
}

interface LiveMarket {
  readonly event?: MarketEvent;
  readonly eventStatus: string;
  readonly eventTicker: string;
  readonly eventTitle: string;
  readonly category: string;
  readonly contract: MarketContract;
}

interface Quote {
  readonly instrumentSymbol: InstrumentSymbol;
  readonly status: string;
  readonly eventStatus: string;
  readonly category: string;
  readonly marketState: string;
  readonly limitPrice: UsdCents;
  readonly limits: ContractLimits | null;
}

interface PendingRecord {
  readonly decision: PendingTrade;
  readonly intent: TradeIntent;
}

function sourceDomain(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return undefined;
  }
}

function newsView(news: NewsItem): NewsView {
  const domain = sourceDomain(news.url);
  return {
    id: news.id,
    text: news.text,
    postedAt: news.postedAt.toISOString(),
    ...(news.url ? { url: news.url } : {}),
    ...(domain ? { sourceDomain: domain } : {}),
    ...(news.author ? { author: news.author } : {}),
  };
}

function marketView(market: LiveMarket): MarketView {
  return {
    eventTicker: market.eventTicker,
    eventTitle: market.eventTitle,
    contractLabel: market.contract.label,
    instrumentSymbol: market.contract.instrumentSymbol,
    yesCents: market.contract.prices.buyYesCents,
    noCents: market.contract.prices.buyNoCents,
    marketState: market.contract.marketState,
  };
}

function candidateMarket(candidate: MatchCandidate): LiveMarket {
  return {
    eventStatus: candidate.eventStatus,
    eventTicker: candidate.eventTicker,
    eventTitle: candidate.eventTitle,
    category: candidate.eventCategory,
    contract: candidate.contract,
  };
}

function postCandidateMarket(candidate: PostCandidate): LiveMarket {
  return {
    eventStatus: candidate.eventStatus,
    eventTicker: candidate.eventTicker,
    eventTitle: candidate.eventTitle,
    category: candidate.category,
    contract: candidate.contract,
  };
}

function matchView(match: MatchResult | undefined, best: LiveMarket | undefined): MatchView {
  if (!match) return { kind: "no-news" };
  if (match.kind === "no-match") return { kind: "no-match", reason: match.reason };
  return { kind: "matched", market: marketView(best ?? candidateMarket(match.best)), reasons: match.reasons };
}

function quoteFor(market: LiveMarket | undefined, outcome: Outcome): Quote | undefined {
  if (!market) return undefined;
  const { buyYesCents, buyNoCents } = market.contract.prices;
  const { instrumentSymbol, status, marketState, limits } = market.contract;
  return { instrumentSymbol, status, marketState, eventStatus: market.eventStatus, category: market.category,
    limitPrice: usdCents((outcome === "yes" ? buyYesCents : buyNoCents) ?? 0), limits };
}

function failureReason(error: ExecutionError): string {
  switch (error.code) {
    case "ledger-not-configured": return "The ledger isn't configured, so I did not place the trade.";
    case "invalid-limit-price": return "I couldn't get a valid price for this market, so I did not place the trade.";
    case "quantity-below-minimum": return "That amount is below the market's minimum order size, so I did not place the trade.";
    case "debit-unconfirmed": return "The payment could not be confirmed, so those funds stay reserved until it is checked.";
    case "journal-unavailable":
    case "pre-broadcast-failed": return "I couldn't record the payment safely, so I did not place the trade.";
    case "destination-invalid": return "The vault recipient's USDC account isn't valid, so I did not place the trade.";
    case "unsafe-ledger-network": return "The ledger network is not approved for test payments.";
    case "recipient-ata-missing": return "The vault recipient has no USDC account yet, so I did not place the trade.";
    case "notional-overflow": return "The trade amount exceeds the ledger limit.";
    case "invalid-notional":
    case "invalid-recipient":
    case "debit-preparation-failed":
    case "debit-rejected":
    case "balance-failed": return "The ledger payment failed, so I did not place the trade.";
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
}

export function createDesk(deps: DeskDeps): Desk {
  const { markets, ledger, now, idGen } = deps;
  const llm = selectLlm({ grok: deps.feed.grok, claude: deps.feed.claude, fetch: deps.fetch ?? fetch });
  const postMatcher = createPostMatcher({
    markets,
    llm,
    categories: CARD_CATEGORIES,
    now,
  });
  let policy = deps.policy;
  const initialLog = (deps.initialLog ?? []).slice(0, LOG_LIMIT);
  const journal = deps.journal ?? createMemoryJournal(() => now().toISOString());
  const currentState = (): PolicyState => policyStateFromSpends(journal.entries(), now());
  let current: { readonly news: NewsItem; readonly match: MatchResult } | undefined;
  const history = deps.history ?? createMemoryHistory();
  const saveLog = deps.saveLog ?? (() => Promise.resolve());
  const lastMarks = new Map<string, MarketMark>();
  let log: readonly DecisionLogEntry[] = initialLog;
  let purchases: readonly StoredPurchase[] = (deps.initialPurchases ?? []).slice(0, PURCHASE_LIMIT);
  const savePurchases = deps.savePurchases ?? (() => Promise.resolve());
  let matches: StoredMatch[] = capMatches(deps.initialMatches ?? []);
  const saveMatches = deps.saveMatches ?? (() => Promise.resolve());
  const deepDives = new Map<string, Promise<DeepDiveResult>>();
  const inFlight = new Set<string>();
  const pending = new Map<string, PendingRecord>();
  const tickers = new Map<InstrumentSymbol, string>();
  const listedContracts = new Map<string, ReadonlySet<string>>();
  const matchCache = new Map<string, { readonly at: number; readonly post: PostInput; readonly match: Promise<FeedMatch> }>();
  const feedOrders = deps.feedOrders ?? createFeedOrders();
  const buying = new Map<string, Promise<DecisionLogEntry>>();
  const confirming = new Map<string, Promise<ConfirmResult>>();

  function recordPrice(market: LiveMarket): void {
    const { instrumentSymbol: symbol, prices } = market.contract;
    history.watch(symbol);
    if (prices.buyYesCents === null) return;
    history.record(symbol, { atMs: now().getTime(), yesCents: prices.buyYesCents, bidCents: prices.bestBidCents, askCents: prices.bestAskCents });
  }

  function priceHistory(symbol: InstrumentSymbol): PricePoint[] {
    return history.series(symbol).slice(-HISTORY_LIMIT).map((point) => ({ at: new Date(point.atMs).toISOString(), yesCents: point.yesCents }));
  }

  function tradeBlockedReason(market: LiveMarket): string | undefined {
    const { contract } = market;
    const refusal = marketPolicyRefusal(policy, contract.instrumentSymbol, market.category);
    if (refusal) return refusal;
    const open = market.eventStatus === "active" && contract.status === "active" && contract.marketState === "open";
    if (!open) return "This market isn't open for trading.";
    return contract.prices.buyYesCents === null || contract.prices.buyNoCents === null ? "This contract has no live price right now." : undefined;
  }

  function feedMarketView(market: LiveMarket): FeedMarketView {
    const { prices, limits } = market.contract;
    const blocked = tradeBlockedReason(market);
    return {
      ...marketView(market),
      geminiUrl: `https://www.gemini.com/predictions/${encodeURIComponent(market.eventTicker)}${market.event?.slug ? `/${encodeURIComponent(market.event.slug)}` : ""}?status=active`,
      description: market.contract.description || market.event?.description || "",
      expiryDate: market.contract.expiryDate ?? market.event?.expiryDate ?? null,
      ...(limits === null ? {} : { quantityLimits: {
        quantityIncrementHundredths: Number(limits.quantityIncrementHundredths),
        quantityMinimumHundredths: Number(limits.quantityMinimumHundredths),
      } }),
      category: market.category,
      impliedYesPercent: prices.buyYesCents,
      bestBidCents: prices.bestBidCents,
      bestAskCents: prices.bestAskCents,
      lastTradeCents: prices.lastTradeCents,
      tradeable: blocked === undefined,
      ...(blocked === undefined ? {} : { tradeBlockedReason: blocked }),
    };
  }

  function feedContracts(market: LiveMarket): readonly FeedMarketView[] {
    return market.event?.contracts.map((contract) => feedMarketView({ ...market, contract })) ?? [feedMarketView(market)];
  }

  function appendRecord(complete: DecisionLogEntry): DecisionLogEntry {
    log = [complete, ...log].slice(0, LOG_LIMIT);
    saveLog(log).catch(() => undefined);
    return complete;
  }

  function record(entry: Omit<DecisionLogEntry, "entryId" | "at">): DecisionLogEntry {
    return appendRecord({ ...entry, entryId: idGen(), at: now().toISOString() });
  }

  function tradeFields(intent: TradeIntent) {
    return {
      intentId: intent.intentId,
      symbol: intent.instrumentSymbol,
      outcome: intent.outcome,
      notionalCents: intent.notional,
      senderId: intent.senderId,
      source: intent.source,
    };
  }

  async function resolveMarket(symbol: InstrumentSymbol, refresh = false): Promise<LiveMarket | undefined> {
    const eventTicker = tickers.get(symbol) ?? parseInstrumentSymbol(symbol)?.eventTicker;
    if (!eventTicker) return undefined;
    const result = await markets.getEvent(eventTicker, { refresh });
    if (!result.ok) return undefined;
    const contract = result.value.contracts.find((candidate) => candidate.instrumentSymbol === symbol);
    if (!contract) return undefined;
    for (const sibling of result.value.contracts) tickers.set(sibling.instrumentSymbol, eventTicker);
    listedContracts.set(eventTicker, new Set(result.value.contracts.map((sibling) => sibling.instrumentSymbol)));
    const market = { event: result.value, eventTicker, eventStatus: result.value.status, eventTitle: result.value.title, category: result.value.category, contract };
    recordPrice(market);
    return market;
  }

  async function computeFeedMatch(post: PostInput): Promise<FeedMatch> {
    const result = await postMatcher.matchPost(post);
    if (result.kind === "no-match") return { kind: "no-match", postId: post.id, matchedBy: result.matchedBy, reason: result.reason };
    const symbol = result.candidate.contract.instrumentSymbol;
    tickers.set(symbol, result.candidate.eventTicker);
    const market = (await resolveMarket(symbol)) ?? postCandidateMarket(result.candidate);
    return {
      kind: "matched",
      postId: post.id,
      matchedBy: result.matchedBy,
      confidence: result.confidence,
      why: result.why,
      market: feedMarketView(market),
      contracts: feedContracts(market),
    };
  }

  function cachedFeedMatch(post: PostInput): Promise<FeedMatch> {
    const nowMs = now().getTime();
    const hit = matchCache.get(post.id);
    if (hit && nowMs - hit.at < MATCH_CACHE_TTL_MS) {
      matchCache.delete(post.id);
      matchCache.set(post.id, hit);
      return hit.match;
    }
    const match = computeFeedMatch(post);
    match.then((resolved) => {
      if (resolved.kind === "matched") rememberFeedMatch(post, resolved, nowMs);
    }).catch(() => undefined);
    matchCache.set(post.id, { at: nowMs, post, match });
    for (const oldest of matchCache.keys()) {
      if (matchCache.size <= MATCH_CACHE_LIMIT) break;
      matchCache.delete(oldest);
    }
    match.catch(() => matchCache.delete(post.id));
    return match;
  }

  function isFeedContract(match: FeedMatch | undefined, symbol: string): boolean {
    return match?.kind === "matched" && (match.market.instrumentSymbol === symbol || listedContracts.get(match.market.eventTicker)?.has(symbol) === true);
  }

  function rememberFeedMatch(post: PostInput, match: Extract<FeedMatch, { kind: "matched" }>, seenAtMs: number): void {
    const symbols = [match.market.instrumentSymbol, ...(match.contracts ?? []).map((contract) => contract.instrumentSymbol)];
    const stored: StoredMatch = {
      postId: post.id,
      symbols,
      source: "x-feed",
      text: post.text,
      author: post.author ?? null,
      url: post.url ?? null,
      why: match.why,
      atMs: tweetTimeMs(post.id) ?? seenAtMs,
    };
    matches = capMatches([stored, ...matches.filter((item) => item.postId !== stored.postId)]);
    saveMatches(matches).catch(() => undefined);
  }

  function journalPurchase(entry: SpendEntry): StoredPurchase | undefined {
    const { signature, explorerUrl } = entry;
    if (entry.kind !== "research" || entry.status !== "settled" || signature === undefined || explorerUrl === undefined) return undefined;
    return {
      symbol: entry.symbol,
      atMs: Date.parse(entry.resolvedAt ?? entry.reservedAt),
      brief: null,
      receipt: { signature, explorerUrl, costCents: entry.notionalCents },
    };
  }

  function purchaseFor(symbol: string): StoredPurchase | undefined {
    const nowMs = now().getTime();
    const known = new Set(purchases.map((purchase) => purchase.receipt.signature));
    const recent = (purchase: StoredPurchase) =>
      nowMs - purchase.atMs < (purchase.brief ? PURCHASE_REUSE_MS : UNDELIVERED_RECOVERY_MS);
    const candidates = purchases.filter((purchase) => purchase.symbol === symbol && recent(purchase));
    for (const entry of journal.entries()) {
      if (entry.symbol !== symbol) continue;
      const purchase = journalPurchase(entry);
      if (purchase && !known.has(purchase.receipt.signature) && recent(purchase)) candidates.push(purchase);
    }
    return candidates.sort((a, b) => b.atMs - a.atMs)[0];
  }

  function storePurchases(next: readonly StoredPurchase[]): void {
    purchases = next.slice(0, PURCHASE_LIMIT);
    savePurchases(purchases).catch(() => undefined);
  }

  function rememberPurchase(result: DeepDiveResult, symbol: string): void {
    if (!result.purchase) return;
    const { signature, explorerUrl, costCents, at } = result.purchase;
    storePurchases([
      {
        symbol,
        atMs: Date.parse(at),
        brief: result.brief,
        receipt: { signature, explorerUrl, costCents },
        yesCents: result.brief?.evidence?.yesCentsWhenWritten ?? (result.brief ? yesCentsFromBrief(result.brief) : null),
        author: result.brief?.author ?? "desk",
      },
      ...purchases.filter((purchase) => purchase.receipt.signature !== signature),
    ]);
  }

  function deliveredFrom(purchase: StoredPurchase, brief: ResearchBrief, note: string): DeepDiveResult {
    return {
      status: "delivered",
      alreadyPurchased: true,
      trace: [{ step: "brief", detail: note }],
      failureReason: null,
      brief,
      purchase: { at: new Date(purchase.atMs).toISOString(), ...purchase.receipt },
    };
  }

  function unfinishedResult(reason: string, purchase: StoredPurchase | undefined): DeepDiveResult {
    return {
      status: "failed",
      alreadyPurchased: purchase !== undefined,
      trace: [],
      failureReason: reason,
      brief: null,
      purchase: purchase ? { at: new Date(purchase.atMs).toISOString(), ...purchase.receipt } : null,
    };
  }

  async function recoverPurchase(purchase: StoredPurchase): Promise<DeepDiveResult> {
    const brief = await deps.research?.resource.recover(purchase.symbol, purchase.receipt.signature);
    if (!brief) return unfinishedResult("You already paid for this brief, but I couldn't fetch it yet. I won't charge you again, so try again in a moment.", purchase);
    storePurchases([{ ...purchase, brief }, ...purchases.filter(({ receipt }) => receipt.signature !== purchase.receipt.signature)]);
    return deliveredFrom(purchase, brief, "I had already paid for this brief, so I fetched it again without paying.");
  }

  function paymentStillInFlight(symbol: string): boolean {
    return journal.entries().some((entry) => entry.kind === "research" && entry.symbol === symbol && entry.status === "reserved");
  }

  function deepDive(symbol: string): Promise<DeepDiveResult> {
    const reusable = purchaseFor(symbol);
    if (reusable?.brief) return Promise.resolve(deliveredFrom(reusable, reusable.brief, "You already bought this brief in the last 15 minutes, so I did not pay again."));
    const running = deepDives.get(symbol);
    if (running) return running;
    let operationId: string | undefined;
    const work = reusable
      ? recoverPurchase(reusable)
      : paymentStillInFlight(symbol)
        ? Promise.resolve(unfinishedResult("A payment for this brief is still being confirmed, so I won't pay a second time. Try again later.", undefined))
        : buyDeepDive(
            {
              ledger,
              ledgerView: deps.ledgerView,
              settings: deps.research,
              account: {
                decide: (spend) => evaluateResearch(spend, policy, currentState(), now()),
                async begin(approved, researchSymbol) {
                  operationId = approved.intentId;
                  inFlight.add(operationId);
                  const written = await journal.begin({
                    operationId: approved.intentId,
                    kind: "research",
                    notionalCents: approved.notional,
                    symbol: researchSymbol,
                    outcome: null,
                    senderId: "research-agent",
                    source: "research",
                  });
                  if (!written.ok) inFlight.delete(operationId);
                  return written.ok;
                },
                async signed(approved, payment) {
                  return (await journal.attachPayment(approved.intentId, payment)).ok;
                },
                async resolve(approved, outcome) {
                  if (!inFlight.has(approved.intentId)) return;
                  await (outcome === "settled" ? journal.settle(approved.intentId) : journal.fail(approved.intentId));
                },
                remaining: () => remainingBudget(policy, currentState(), now()),
                record,
              },
            },
            symbol,
          ).then((result) => {
            rememberPurchase(result, symbol);
            return result;
          });
    deepDives.set(symbol, work);
    const forget = () => {
      if (operationId !== undefined) inFlight.delete(operationId);
      deepDives.delete(symbol);
    };
    work.then(forget, forget);
    return work;
  }

  function ticketRecord(ticket: PaperOrderTicket) {
    return {
      ticketId: ticket.ticketId,
      symbol: ticket.payload.symbol,
      outcome: ticket.payload.outcome,
      quantity: ticket.payload.quantity,
      price: ticket.payload.price,
      mode: ticket.mode,
    };
  }

  async function execute(approved: ApprovedTrade, intent: TradeIntent, quote: Quote): Promise<DecisionLogEntry> {
    inFlight.add(approved.intentId);
    try {
      return await executeTrade(approved, intent, quote);
    } finally {
      inFlight.delete(approved.intentId);
    }
  }

  async function executeTrade(approved: ApprovedTrade, intent: TradeIntent, quote: Quote): Promise<DecisionLogEntry> {
    const operationId = approved.intentId;
    const reservation = { opened: false };
    const trade = await executeApproved(approved, {
      ledger,
      now,
      idGen,
      limitPrice: quote.limitPrice,
      limits: quote.limits,
      async reserve(ticket) {
        const written = await journal.begin({
          operationId,
          kind: "trade",
          notionalCents: approved.notional,
          symbol: intent.instrumentSymbol,
          outcome: intent.outcome,
          senderId: intent.senderId,
          source: intent.source,
          ticket: ticketRecord(ticket),
        });
        reservation.opened = written.ok;
        return written.ok;
      },
      async beforeBroadcast(payment) {
        return (await journal.attachPayment(operationId, payment)).ok;
      },
    });
    if (reservation.opened) {
      if (trade.kind === "paper-order") await journal.settle(operationId);
      else if (trade.error.code !== "debit-unconfirmed") await journal.fail(operationId);
    }
    if (trade.kind === "execution-failed") {
      return record({
        ...tradeFields(intent),
        kind: "execution-failed",
        code: trade.error.code,
        spokenReason: failureReason(trade.error),
      });
    }
    const { ticket, debit } = trade;
    return record({
      ...tradeFields(intent),
      kind: "approve",
      spokenReason: trade.spokenReason,
      signature: debit.signature,
      explorerUrl: debit.explorerUrl,
      ticket: {
        ticketId: ticket.ticketId,
        symbol: ticket.payload.symbol,
        outcome: ticket.payload.outcome,
        quantity: ticket.payload.quantity,
        price: ticket.payload.price,
        mode: ticket.mode,
      },
    });
  }

  function tradeIntent(request: ProposeRequest): TradeIntent {
    return {
      intentId: idGen(),
      instrumentSymbol: instrumentSymbol(request.instrumentSymbol),
      outcome: request.outcome,
      notional: usdCents(request.notionalCents),
      source: request.source,
      senderId: request.senderId,
      createdAt: now(),
      ...(request.seenPriceCents === undefined ? {} : { seenPriceCents: request.seenPriceCents }),
    };
  }

  async function proposeTrade(request: ProposeRequest): Promise<DecisionLogEntry> {
    return proposeIntent(tradeIntent(request), false, request.requireApproval === true);
  }

  async function proposeIntent(intent: TradeIntent, persistApproval = false, requireApproval = false): Promise<DecisionLogEntry> {
    const quote = quoteFor(await resolveMarket(intent.instrumentSymbol, true), intent.outcome);
    const evaluated = evaluate(intent, quote, policy, currentState(), now());
    const decision = requireApproval && evaluated.kind === "approve" ? restorePendingApproval(intent) : evaluated;
    switch (decision.kind) {
      case "refuse":
        return record({ ...tradeFields(intent), kind: "refuse", code: decision.code, spokenReason: decision.spokenReason });
      case "needs-approval":
        if (!persistApproval) pending.set(intent.intentId, { decision, intent });
        return record({ ...tradeFields(intent), kind: "needs-approval", spokenReason: decision.spokenReason });
      case "approve":
        if (!quote) throw new Error("Approval requires a quote");
        return execute(decision, intent, quote);
      default: {
        const exhaustive: never = decision;
        return exhaustive;
      }
    }
  }

  function existingFeedResult({ entry }: FeedOrder): FeedOrder["entry"] {
    if (!awaitingPaymentResult(entry)) return entry;
    const spend = journal.find(entry.intentId);
    if (spend?.status === "settled") {
      const result: FeedOrder["entry"] = {
        ...entry,
        kind: "approve",
        at: spend.resolvedAt ?? entry.at,
        spokenReason: "The payment landed and the paper trade was recorded.",
        ...(spend.signature === undefined ? {} : { signature: spend.signature }),
        ...(spend.explorerUrl === undefined ? {} : { explorerUrl: spend.explorerUrl }),
        ...(spend.ticket === undefined ? {} : { ticket: spend.ticket }),
      };
      delete result.code;
      return result;
    }
    if (spend?.status === "failed") {
      return { ...entry, at: spend.resolvedAt ?? entry.at, code: "debit-rejected", spokenReason: "The payment failed or expired and the reservation was released." };
    }
    return entry;
  }

  function feedOrder(clientOrderId: string): Promise<DecisionLogEntry> | undefined {
    const active = buying.get(clientOrderId);
    if (active) return active;
    const order = feedOrders.find(clientOrderId);
    if (order) return Promise.resolve(existingFeedResult(order));
    return undefined;
  }

  async function saveFeedResult(order: FeedOrder, result: DecisionLogEntry): Promise<DecisionLogEntry> {
    const entry = { ...result, source: "feed" as const, outcome: order.entry.outcome };
    await feedOrders.update(order, { ...order, entry });
    return entry;
  }

  function buyFromFeed({ clientOrderId, ...request }: FeedBuyRequest): Promise<DecisionLogEntry> {
    const previous = feedOrder(clientOrderId);
    if (previous) return previous;
    const intent = tradeIntent({ ...request, source: "feed", senderId: deps.feed.operatorId });
    const trade = recordPendingOrder(clientOrderId, intent);
    buying.set(clientOrderId, trade);
    const forget = () => buying.delete(clientOrderId);
    void trade.then(forget, forget);
    return trade;
  }

  function pendingFeedEntry(entry: Omit<FeedOrder["entry"], "kind" | "spokenReason">): FeedOrder["entry"] {
    return { ...entry, kind: "execution-failed", code: "order-in-progress", spokenReason: "This order is pending. Check again for its result." };
  }

  async function recordPendingOrder(clientOrderId: string, intent: TradeIntent): Promise<DecisionLogEntry> {
    const eventTicker = tickers.get(intent.instrumentSymbol);
    const order: FeedOrder = {
      clientOrderId,
      seenPriceCents: intent.seenPriceCents,
      eventTicker,
      entry: pendingFeedEntry({
        ...tradeFields(intent),
        source: "feed",
        entryId: idGen(),
        at: intent.createdAt.toISOString(),
      }),
    };
    const existing = await feedOrders.claim(order);
    if (existing) return existingFeedResult(existing);
    return saveFeedResult(order, await proposeIntent(intent, true));
  }

  function confirmFeedOrder(order: FeedOrder, approverId: string): Promise<ConfirmResult> {
    const { entry } = order;
    const active = confirming.get(entry.intentId);
    if (active) return active;
    if (entry.kind !== "needs-approval") return Promise.resolve({ ok: true, entry: existingFeedResult(order) });
    const work = completeFeedApproval(order, approverId);
    confirming.set(entry.intentId, work);
    const forget = () => confirming.delete(entry.intentId);
    void work.then(forget, forget);
    return work;
  }

  async function completeFeedApproval(order: FeedOrder, approverId: string): Promise<ConfirmResult> {
    const { entry, seenPriceCents, eventTicker } = order;
    const intent: TradeIntent = {
      intentId: entry.intentId,
      instrumentSymbol: instrumentSymbol(entry.symbol),
      outcome: entry.outcome,
      notional: usdCents(entry.notionalCents),
      source: entry.source,
      senderId: entry.senderId,
      createdAt: new Date(entry.at),
      ...(seenPriceCents === undefined ? {} : { seenPriceCents }),
    };
    if (eventTicker !== undefined) tickers.set(intent.instrumentSymbol, eventTicker);
    const quote = quoteFor(await resolveMarket(intent.instrumentSymbol, true), intent.outcome);
    const confirmed = confirm(restorePendingApproval(intent), approverId, quote, policy, currentState(), now());
    if (confirmed.kind === "refuse") {
      return { ok: true, entry: record({ ...tradeFields(intent), kind: "refuse", code: confirmed.code, spokenReason: confirmed.spokenReason }) };
    }
    if (!quote) throw new Error("Approval requires a quote");
    const executing = { ...order, entry: pendingFeedEntry({ ...entry, at: now().toISOString() }) };
    if (!await feedOrders.update(order, executing)) return { ok: false, error: "unknown-intent" };
    const fresh = confirm(restorePendingApproval(intent), approverId, quote, policy, currentState(), now());
    const result = fresh.kind === "refuse"
      ? record({ ...tradeFields(intent), kind: "refuse", code: fresh.code, spokenReason: fresh.spokenReason })
      : await execute(fresh, intent, quote);
    return { ok: true, entry: await saveFeedResult(executing, result) };
  }

  async function confirmPending(intentId: string, approverId: string): Promise<ConfirmResult> {
    const feed = feedOrders.findIntent(intentId);
    if (feed) return confirmFeedOrder(feed, approverId);
    const waiting = pending.get(intentId);
    if (!waiting) return { ok: false, error: "unknown-intent" };
    const quote = quoteFor(await resolveMarket(waiting.intent.instrumentSymbol, true), waiting.intent.outcome);
    const confirmed = confirm(waiting.decision, approverId, quote, policy, currentState(), now());
    if (confirmed.kind === "refuse") {
      if (confirmed.code === "duplicate-intent") pending.delete(intentId);
      return {
        ok: true,
        entry: record({ ...tradeFields(waiting.intent), kind: "refuse", code: confirmed.code, spokenReason: confirmed.spokenReason }),
      };
    }
    if (!pending.delete(intentId)) return { ok: false, error: "unknown-intent" };
    if (!quote) throw new Error("Approval requires a quote");
    return { ok: true, entry: await execute(confirmed, waiting.intent, quote) };
  }

  async function rejectPending(intentId: string, approverId: string): Promise<ConfirmResult> {
    if (!policy.senderAllowlist.has(approverId)) return { ok: false, error: "unauthorized-approver" };
    const active = confirming.get(intentId);
    if (active) return active;
    const feed = feedOrders.findIntent(intentId);
    if (feed) {
      if (feed.entry.kind !== "needs-approval") return { ok: true, entry: existingFeedResult(feed) };
      const rejected: typeof feed.entry = {
        intentId: feed.entry.intentId,
        symbol: feed.entry.symbol,
        outcome: feed.entry.outcome,
        notionalCents: feed.entry.notionalCents,
        senderId: feed.entry.senderId,
        source: feed.entry.source,
        kind: "refuse",
        code: "rejected",
        spokenReason: "You rejected this trade.",
        entryId: idGen(),
        at: now().toISOString(),
      };
      if (!await feedOrders.update(feed, { ...feed, entry: rejected })) {
        const latest = feedOrders.findIntent(intentId);
        return latest === undefined
          ? { ok: false, error: "unknown-intent" }
          : { ok: true, entry: existingFeedResult(latest) };
      }
      return { ok: true, entry: appendRecord(rejected) };
    }
    const waiting = pending.get(intentId);
    if (!waiting) return { ok: false, error: "unknown-intent" };
    if (!pending.delete(intentId)) return { ok: false, error: "unknown-intent" };
    return {
      ok: true,
      entry: record({
        ...tradeFields(waiting.intent),
        kind: "refuse",
        code: "rejected",
        spokenReason: "You rejected this trade.",
      }),
    };
  }

  function budgetView(rolled: PolicyState, config: Policy): FeedPositions["budget"] {
    return {
      dailyCapCents: config.dailyCap,
      spentCents: rolled.spentToday,
      researchSpentCents: todaysResearchSpendCents(journal.entries(), rolled.day),
      remainingCents: Math.max(0, config.dailyCap - rolled.spentToday - rolled.reservedToday),
      perTradeMaxCents: config.perTradeMax,
      autoApproveMaxCents: config.autoApproveMax,
    };
  }

  async function readPositions(status?: PositionStatus) {
    const fills = fillsFromJournal(journal.entries());
    const byEvent = new Map<string, Set<string>>();
    for (const { symbol } of fills) {
      const parsed = parseInstrumentSymbol(symbol);
      if (parsed) byEvent.set(parsed.eventTicker, (byEvent.get(parsed.eventTicker) ?? new Set()).add(symbol));
    }
    await Promise.all(
      [...byEvent].map(async ([eventTicker, symbols]) => {
        const result = await markets.getEvent(eventTicker);
        if (!result.ok) return;
        for (const contract of result.value.contracts) {
          if (symbols.has(contract.instrumentSymbol)) lastMarks.set(contract.instrumentSymbol, markFromContract(result.value, contract, now().getTime()));
        }
      }),
    );
    return aggregatePositions(fills, lastMarks, now().toISOString(), status);
  }

  async function loadPortfolioMarkets(symbols: readonly string[]): Promise<Map<string, PortfolioMarket>> {
    const byEvent = new Map<string, Set<string>>();
    for (const symbol of symbols) {
      const parsed = parseInstrumentSymbol(symbol);
      if (parsed) byEvent.set(parsed.eventTicker, (byEvent.get(parsed.eventTicker) ?? new Set()).add(symbol));
    }
    const found = new Map<string, PortfolioMarket>();
    await Promise.all(
      [...byEvent].map(async ([eventTicker, wanted]) => {
        const result = await markets.getEvent(eventTicker);
        if (!result.ok) return;
        for (const contract of result.value.contracts) {
          if (!wanted.has(contract.instrumentSymbol)) continue;
          const mark = markFromContract(result.value, contract, now().getTime());
          found.set(contract.instrumentSymbol, {
            ...mark,
            category: result.value.category,
            expiryDate: contract.expiryDate ?? result.value.expiryDate,
          });
          lastMarks.set(contract.instrumentSymbol, mark);
        }
      }),
    );
    return found;
  }

  async function loadCandles(symbols: readonly string[]): Promise<Map<string, readonly Candle[]>> {
    const loader = markets.candles;
    const found = new Map<string, readonly Candle[]>();
    if (loader === undefined || symbols.length === 0) return found;
    const timeframe: CandleTimeframe = "1day";
    await Promise.all(
      symbols.map(async (symbol) => {
        const result = await loader(symbol, timeframe);
        if (result.ok && result.value.length > 0) found.set(symbol, result.value);
      }),
    );
    return found;
  }

  return {
    async submitNews(news) {
      const match = await matchNews(news, { client: markets });
      current = { news, match };
      if (match.kind === "matched") {
        for (const candidate of [match.best, ...match.alternatives]) {
          tickers.set(candidate.contract.instrumentSymbol, candidate.eventTicker);
        }
      }
      return matchView(match, undefined);
    },

    matchPost: cachedFeedMatch,

    async isCardFor(postId, symbol) {
      const hit = matchCache.get(postId);
      if (!hit || now().getTime() - hit.at >= MATCH_CACHE_TTL_MS) return false;
      const match = await hit.match.catch(() => undefined);
      return isFeedContract(match, symbol);
    },

    async quote(symbol) {
      const market = await resolveMarket(instrumentSymbol(symbol));
      if (!market) return undefined;
      return { market: feedMarketView(market), contracts: feedContracts(market), history: priceHistory(market.contract.instrumentSymbol) };
    },

    async postContextFor(symbol) {
      return (await this.matchedPostsFor(symbol))[0];
    },

    async matchedPostsFor(symbol) {
      const nowMs = now().getTime();
      const posts: ResearchPostContext[] = [];
      for (const stored of matches) {
        if (stored.symbols.includes(symbol)) posts.push(matchToContext(stored));
      }
      for (const { at, post, match } of [...matchCache.values()].reverse()) {
        if (nowMs - at >= MATCH_CACHE_TTL_MS) continue;
        const resolved = await match.catch(() => undefined);
        if (resolved?.kind === "matched" && isFeedContract(resolved, symbol)) {
          posts.push({ source: "x-feed", text: post.text, author: post.author ?? null, url: post.url ?? null, why: resolved.why, atMs: tweetTimeMs(post.id) ?? at });
        }
      }
      if (current?.match.kind === "matched" && current.match.best.contract.instrumentSymbol === symbol) {
        const { news } = current;
        const atMs = news.postedAt.getTime();
        posts.push({
          source: "news",
          text: news.text,
          author: news.author ?? null,
          url: news.url ?? null,
          why: current.match.reasons.join(" ") || null,
          atMs,
        });
      }
      return posts;
    },

    peekResearchBriefs(symbol) {
      const list = purchases
        .filter((purchase) => purchase.symbol === symbol && purchase.brief !== null)
        .sort((a, b) => b.atMs - a.atMs);
      return { current: list[0] ?? null, previous: list[1] ?? null };
    },

    listBriefLibrary() {
      return buildBriefLibrary({
        purchases,
        now: now(),
        getEvent: (ticker) => markets.getEvent(ticker),
      });
    },

    async getPositions() {
      return { ...await readPositions(), researchSpend: summarizeResearchSpend(journal.entries(), now().toISOString()) };
    },

    async getPortfolio(range) {
      const selected = parsePortfolioRange(range);
      const entries = journal.entries();
      const symbols = [...new Set(entries.map((entry) => entry.symbol))];
      const [portfolioMarkets, candles] = await Promise.all([loadPortfolioMarkets(symbols), loadCandles(symbols)]);
      const historySeries = new Map(symbols.map((symbol) => [symbol, history.series(symbol)]));
      return buildPortfolio({
        entries,
        markets: portfolioMarkets,
        history: historySeries,
        candles,
        dailyCapCents: policy.dailyCap,
        range: selected,
        nowMs: now().getTime(),
      });
    },

    async getFeedPositions() {
      const { positions, totals } = await readPositions("open");
      return {
        positions: positions.map(({ symbol, outcome, eventTitle, contractLabel, contracts, averageEntryCents, currentCents, pnlCents, pnlPercent, fills }) => ({
          symbol, outcome, eventTitle, contractLabel, contracts, averageEntryCents, currentCents, pnlCents, pnlPercent,
          explorerUrl: fills.findLast((fill) => fill.explorerUrl !== null)?.explorerUrl ?? null,
          researchPath: `/markets/${encodeURIComponent(symbol)}`,
        })),
        totals,
        budget: budgetView(currentState(), policy),
      };
    },

    buyDeepDive: deepDive,

    reconcile: singleReconciliation(async () => {
      const result = await reconcileJournal(journal, (payment) => ledger.checkSignature(payment), inFlight, deps.paymentInFlight);
      for (const order of feedOrders.all()) {
        if (buying.has(order.clientOrderId) || confirming.has(order.entry.intentId)) continue;
        if (!awaitingPaymentResult(order.entry)) continue;
        const entry = journal.find(order.entry.intentId) === undefined
          ? { ...order.entry, code: "order-interrupted", spokenReason: "The order stopped before a payment was recorded." }
          : existingFeedResult(order);
        if (entry !== order.entry) await feedOrders.update(order, { ...order, entry }).catch(() => undefined);
      }
      return result;
    }),

    feedOrder,
    buyFromFeed,

    confirmFromFeed(intentId) {
      const order = feedOrders.findIntent(intentId);
      if (order) return confirmFeedOrder(order, deps.feed.operatorId);
      if (pending.get(intentId)?.intent.source === "feed") return confirmPending(intentId, deps.feed.operatorId);
      return Promise.resolve({ ok: false, error: "unknown-intent" });
    },

    proposeTrade,

    confirmPending,

    rejectPending,

    setKillSwitch(on) {
      policy = policy.withKillSwitch(on);
    },

    async getSnapshot() {
      const rolled = currentState();
      const best = current?.match.kind === "matched" ? await resolveMarket(current.match.best.contract.instrumentSymbol) : undefined;
      const config = policy;
      const policyView: PolicyView = {
        ...budgetView(rolled, config),
        autoApproveMaxCents: config.autoApproveMax,
        perTradeMaxCents: config.perTradeMax,
        killSwitch: config.killSwitch,
        marketAllowlist: [...config.marketAllowlist],
        marketCategories: [...config.marketCategories],
        senderAllowlist: [...config.senderAllowlist],
      };
      const pendingViews: PendingView[] = [...pending.values()].map(({ decision, intent }) => ({
        intentId: decision.intentId,
        symbol: decision.instrumentSymbol,
        outcome: decision.outcome,
        notionalCents: decision.notional,
        senderId: intent.senderId,
        createdAt: intent.createdAt.toISOString(),
      }));
      for (const { entry } of feedOrders.all()) {
        if (entry.kind !== "needs-approval") continue;
        pendingViews.push({
          intentId: entry.intentId,
          symbol: entry.symbol,
          outcome: entry.outcome,
          notionalCents: entry.notionalCents,
          senderId: entry.senderId,
          createdAt: entry.at,
        });
      }
      return {
        news: current ? newsView(current.news) : null,
        match: matchView(current?.match, best),
        policy: policyView,
        pending: pendingViews,
        log: log.slice(0, LOG_VIEW_LIMIT),
        ledger: deps.ledgerView,
      };
    },
  };
}
