/**
 * Level-based institutional day trading types.
 *
 * Replaces the indicator-based confidence model with a level-interaction
 * architecture: price levels + structure + market context.
 */

// ── Level Types ──────────────────────────────────────────────────────────────

export type LevelType =
  | 'pdh' | 'pdl' | 'pdc'                        // Prior day high/low/close
  | 'onh' | 'onl'                                 // Overnight high/low
  | 'orb_high' | 'orb_low'                        // Opening range (first 30 min)
  | 'vwap' | 'vwap_1sig_upper' | 'vwap_1sig_lower' | 'vwap_2sig_upper' | 'vwap_2sig_lower'
  | 'vpoc' | 'val' | 'vah'                        // Volume profile
  | 'weekly_open' | 'monthly_open'                 // Calendar pivots
  | 'gex_call_wall' | 'gex_put_wall' | 'gex_zero' // Gamma exposure
  | 'swing_high' | 'swing_low';                    // Intraday structure

/** A single price level with metadata. */
export interface PriceLevel {
  price: number;
  type: LevelType;
  label: string;                 // human-readable label for logging
  strength: number;              // 1-5 (confluence count — how many level types overlap)
  freshness: 'fresh' | 'tested' | 'broken';
  lastTestedAt?: string;         // ISO timestamp of last touch
  touchCount: number;            // times price has reached this level today
  source: 'premarket' | 'intraday';
}

// ── Level Interaction ────────────────────────────────────────────────────────

export type InteractionType = 'approaching' | 'testing' | 'rejecting' | 'accepting' | 'none';

export interface LevelInteraction {
  level: PriceLevel;
  interaction: InteractionType;
  direction: 'from_above' | 'from_below';  // which side price approached from
  distance: number;              // absolute distance in price
  distancePct: number;           // distance as % of price
  distanceATR: number;           // distance in ATR units
  volumeAtLevel: 'expanding' | 'contracting' | 'normal';
  candleSignal: 'rejection_wick' | 'engulfing' | 'doji' | 'strong_body' | 'none';
  barsAtLevel: number;           // bars within interaction zone
}

// ── Structure Types ─────────────────────────────────────────────────────────

export type StructureState = 'uptrend' | 'downtrend' | 'range' | 'undetermined';

export interface SwingPoint {
  price: number;
  barIndex: number;
  timestamp: string;
  type: 'high' | 'low';
}

export interface FailedBreakout {
  level: PriceLevel;
  direction: 'bullish_fail' | 'bearish_fail'; // broke up then failed, or broke down then failed
  detectedBarIndex: number;
  timestamp: string;
}

export interface StructureAnalysis {
  state: StructureState;
  swingPoints: SwingPoint[];      // recent swing points (last ~10)
  higherHighs: boolean;           // most recent swing high > prior swing high
  higherLows: boolean;            // most recent swing low > prior swing low
  lowerHighs: boolean;
  lowerLows: boolean;
  lastSwingHigh?: SwingPoint;
  lastSwingLow?: SwingPoint;
  failedBreakout?: FailedBreakout;
  volumeProfile: 'expanding_with_trend' | 'expanding_against' | 'contracting' | 'neutral';
}

// ── Market Context Types ────────────────────────────────────────────────────

export type DayType = 'trend_up' | 'trend_down' | 'rotational' | 'reversal' | 'undetermined';
export type VolatilityRegime = 'low' | 'normal' | 'high' | 'extreme';

export interface GapAnalysis {
  gapPct: number;              // (open - pdc) / pdc * 100
  gapFilled: boolean;          // price has returned to pdc
  gapDirection: 'up' | 'down' | 'flat';
}

export interface BreadthData {
  sectorAlignment: number;       // -1 to +1 (all sectors aligned = +1)
  divergingSectors: string[];
  confirmingSectors: string[];
  cumulativeDeltaProxy: number;  // -1 to +1 (net buying = positive)
  deltaTrend: 'increasing' | 'decreasing' | 'flat';
}

export interface GEXData {
  callWallStrike: number;
  putWallStrike: number;
  gexZeroStrike: number;
  totalNetGEX: number;           // positive = pinning regime, negative = acceleration
  regime: 'pinning' | 'accelerating' | 'neutral';
}

export interface MarketContext {
  dayType: DayType;
  gap: GapAnalysis;
  volatilityRegime: VolatilityRegime;
  realizedVolATR: number;        // today's realized ATR as % of price
  avgVolATR: number;             // multi-day average ATR % (baseline)
  minutesSinceOpen: number;
  orbFormed: boolean;            // opening range finalized
  orbBreakoutSustained: boolean; // ORB breakout held for 5+ bars
  breadth?: BreadthData;         // sector ETF breadth proxy
  gex?: GEXData;                 // gamma exposure regime
}

// ── Volume Profile ──────────────────────────────────────────────────────────

export interface VolumeProfileResult {
  vpoc: number;                  // price level with most volume
  valueAreaHigh: number;         // upper bound of 70% volume area
  valueAreaLow: number;          // lower bound of 70% volume area
  totalVolume: number;
  bins: VolumeProfileBin[];
}

export interface VolumeProfileBin {
  priceMin: number;
  priceMax: number;
  priceMid: number;
  volume: number;
  pctOfTotal: number;            // 0-1
}

// ── Setup (trade signal from level interaction) ─────────────────────────────

export type SetupType =
  | 'level_rejection'            // bounce off key level
  | 'failed_breakout'            // broke through then reclaimed
  | 'breakout_acceptance'        // clean break + hold above/below
  | 'vwap_mean_reversion';       // extended from VWAP, reverting

export interface LevelSetup {
  type: SetupType;
  direction: 'bullish' | 'bearish';
  entryPrice: number;
  stopPrice: number;             // other side of the level
  targetPrice: number;           // next significant level
  riskReward: number;            // target distance / stop distance
  level: PriceLevel;             // the level driving this setup
  targetLevel?: PriceLevel;      // the level being targeted
  interaction: LevelInteraction;
  structure: StructureAnalysis;
  context: MarketContext;
}

// ── Level-based Signal Extension ────────────────────────────────────────────

export interface LevelSignalData {
  // All computed levels for the day
  allLevels: PriceLevel[];

  // Nearest levels (sorted by proximity)
  nearestAbove: PriceLevel[];    // max 3
  nearestBelow: PriceLevel[];    // max 3

  // Active interaction (if any)
  activeInteraction: LevelInteraction | null;

  // Structure
  structure: StructureAnalysis;

  // Context
  context: MarketContext;

  // Volume profile
  volumeProfile: VolumeProfileResult;

  // Setup (if conditions met)
  setup: LevelSetup | null;
}

// ── Level-based Confidence Breakdown ────────────────────────────────────────

export interface LevelConfidenceBreakdown {
  base: number;                     // 0.40 starting point
  levelStrength: number;            // 0..+0.15 — confluence of the target level
  interactionQuality: number;       // -0.10..+0.15 — rejection/acceptance clarity
  structureAlignment: number;       // -0.10..+0.12 — HH/HL or LH/LL aligns with trade
  contextAlignment: number;         // -0.08..+0.10 — day type supports the setup
  volumeConfirmation: number;       // -0.06..+0.08 — volume profile at level
  vwapAlignment: number;            // -0.06..+0.06 — VWAP position vs trade direction
  riskRewardScore: number;          // -0.08..+0.08 — next level distance vs stop distance
  failedBreakoutBonus: number;      // 0..+0.10 — failed breakout is highest probability setup
  thetaDecayPenalty: number;        // -0.10..0 — late day theta burn
  total: number;                    // clamped 0..1
}
