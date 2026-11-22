import type { MarketContract } from "@/features/markets";

export interface NewsItem {
  readonly id: string;
  readonly text: string;
  readonly url?: string;
  readonly author?: string;
  readonly postedAt: Date;
}

export interface MatchCandidate {
  readonly eventStatus: string;
  readonly eventTicker: string;
  readonly eventTitle: string;
  readonly eventCategory: string;
  readonly contract: MarketContract;
  readonly score: number;
  readonly matchedTokens: readonly string[];
}

export type MatchResult =
  | {
      readonly kind: "matched";
      readonly best: MatchCandidate;
      readonly alternatives: readonly MatchCandidate[];
      readonly score: number;
      readonly reasons: readonly string[];
    }
  | { readonly kind: "no-match"; readonly reason: string };
