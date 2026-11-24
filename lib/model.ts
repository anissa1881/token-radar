// Token Radar's model, version radar-3: one snapshot of the protocol universe in, one ranked board out.
//
// The board ranks every pre-token protocol the house rules leave rankable: the 40-protocol watchlist
// is the floor, and the early radar adds the pre-token protocols below it plus the ones above the
// floor the list leaves out. Wrapped, staked and bridged products, exchanges and versioned pools are
// set aside with their reasons instead of being ranked as launch candidates, and protocols whose
// token already trades are shown apart at the market's own value, never mixed into the ranking.
//
// Implied value is fitted, never asserted: the multiple a token would carry comes from the protocols
// whose tokens already trade (their market-cap-to-TVL ratios, winsorized, shrunk by category, bent by
// a size curve the data itself fits), and the token odds come from how often peers of the same age
// and family record a token. Every term in the model earns its place by lowering the held-out miss in
// BOTH out-of-sample tests (leave-one-out and walk-forward); a term that fails either is left out and
// the evidence table in the dashboard says so. No protocol name is ever special-cased: the same
// function scores every row, and the bootstrap refits the whole fit 200 times for the ranges the
// board shows.
//
// A farm verdict is economics, not enthusiasm: a modelled drop (a share of the implied value, in
// proportion to the deposit's share of TVL) minus the gas the plan's own transactions cost, against a
// T-bill for the same money and hours. FARM beats both the T-bill and $25 an hour; MARGINAL clears
// zero; SKIP does not.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-3';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** The share of an implied value a farmer's drop is modelled on. */
export const DROP_SHARE = 0.07;
/** The T-bill rate the farm verdict is measured against. */
export const TBILL_RATE = 0.04;
/** The farm horizon, in weeks, every verdict and drop assumes. */
export const HORIZON_WEEKS = 12;
/** The net dollars an hour a farm must clear to earn FARM. */
export const FARM_HOURLY_BAR = 25;
/** How strongly a category's median is pulled toward the global median: n / (n + K). */
export const SHRINK_K = 8;
/** The winsor bounds on a traded peer's market-cap-to-TVL ratio, as quantiles. */
export const WINSOR_LO = 0.05;
export const WINSOR_HI = 0.95;
/** Bootstrap refits behind every range the board shows. */
export const BOOTSTRAP_REPS = 200;
/** The walk-forward cut: peers listed before it fit the model, peers listed after it test it. */
export const WALK_FORWARD_CUT = '2025-01-01';

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The median of a sorted array, or `fallback` when it is empty. */
function medianOf(sorted: number[], fallback: number): number {
  if (sorted.length === 0) return fallback;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A quantile of a sorted array by linear interpolation. */
function quantileOf(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** The house rule's name tests: a name beginning with an exchange's name, or carrying a whole word wrapped, staked or staking. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Categories the house treats as a wrapped, staked or bridged product of a token that trades. */
const WRAPPED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Cross Chain Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
]);

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a wrapped or staked product, not a versioned pool, not named for an exchange. */
export function isRankable(p: SnapshotProtocol): boolean {
  return (
    isPreToken(p) &&
    p.category !== 'CEX' &&
    !VERSIONED.test(p.name) &&
    !WRAPPED_CATEGORIES.has(p.category ?? '') &&
    !EXCHANGE_PREFIX.test(p.name) &&
    !WRAPPED_WORD.test(p.name)
  );
}

/** Why a pre-token protocol is set aside instead of ranked, or null when it is rankable. */
export function setAsideReason(p: SnapshotProtocol): string | null {
  if (!isPreToken(p)) return 'token already trades';
  if (p.category === 'CEX') return 'an exchange, not a launch candidate';
  if (VERSIONED.test(p.name)) return 'a versioned pool of another protocol';
  if (WRAPPED_WORD.test(p.name)) return 'a wrapped or staked product by name';
  if (EXCHANGE_PREFIX.test(p.name)) return 'named for an exchange';
  if (WRAPPED_CATEGORIES.has(p.category ?? '')) return 'a wrapped, staked or bridged product';
  return null;
}

/** A traded peer: a protocol whose token trades and whose market cap and TVL are both recorded. */
export interface Peer {
  slug: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  listed_at: string | null;
  change_7d: number | null;
  ratio: number;
}

/** The traded peers of a snapshot, with their market-cap-to-TVL ratios. */
export function tradedPeers(snapshot: Snapshot): Peer[] {
  return snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .map((p) => ({ slug: p.slug, category: p.category, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd!, listed_at: p.listed_at, change_7d: p.change_7d, ratio: p.mcap_usd! / p.tvl_usd }))
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

/** A winsorized ratio: clipped to the peer distribution's own 5th and 95th percentiles. */
export function winsorize(ratio: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, ratio));
}

/** The fitted multiples: the global median, each category's shrunk median, and the size slope. */
export interface FittedMultiples {
  global: number;
  winsorLo: number;
  winsorHi: number;
  peerCount: number;
  byCategory: Record<string, { n: number; median: number; shrunk: number }>;
  sizeSlope: number;
  sizeCenter: number;
  growthWeight: number;
}

/** The median of a category's winsorized ratios, shrunk toward the global median by n / (n + K). */
export function shrinkMedian(n: number, median: number, global: number): number {
  return (n * median + SHRINK_K * global) / (n + SHRINK_K);
}

/** Fit the multiples on a peer set: winsorize, take the global median, shrink each category, fit the size slope on residuals. */
export function fitMultiples(peers: Peer[], useCategory: boolean, useSize: boolean, growthWeight: number): FittedMultiples {
  const ratios = peers.map((p) => p.ratio).sort((a, b) => a - b);
  const winsorLo = quantileOf(ratios, WINSOR_LO);
  const winsorHi = quantileOf(ratios, WINSOR_HI);
  const clipped = peers.map((p) => winsorize(p.ratio, winsorLo, winsorHi));
  const global = medianOf([...clipped].sort((a, b) => a - b), 0.2);
  const byCategory: Record<string, { n: number; median: number; shrunk: number }> = {};
  if (useCategory) {
    const groups = new Map<string, number[]>();
    peers.forEach((p, i) => {
      const key = p.category ?? 'Other';
      const arr = groups.get(key) ?? [];
      arr.push(clipped[i]!);
      groups.set(key, arr);
    });
    for (const [key, arr] of groups) {
      arr.sort((a, b) => a - b);
      const med = medianOf(arr, global);
      byCategory[key] = { n: arr.length, median: med, shrunk: shrinkMedian(arr.length, med, global) };
    }
  }
  // The size slope: ordinary least squares of log residual ratio on log TVL, centred on the peers'
  // median TVL, so the factor is 1 at a typical size and bends the multiple down for the largest.
  let sizeSlope = 0;
  let sizeCenter = 0;
  if (useSize && peers.length >= 10) {
    const tvls = peers.map((p) => p.tvl_usd).sort((a, b) => a - b);
    sizeCenter = Math.log(medianOf(tvls, 1e8));
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    peers.forEach((p, i) => {
      const cat = useCategory ? (byCategory[p.category ?? 'Other']?.shrunk ?? global) : global;
      const residual = Math.log(Math.max(1e-6, clipped[i]! / cat));
      const x = Math.log(p.tvl_usd) - sizeCenter;
      sx += x;
      sy += residual;
      sxx += x * x;
      sxy += x * residual;
    });
    const n = peers.length;
    const denom = n * sxx - sx * sx;
    sizeSlope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
    if (!Number.isFinite(sizeSlope)) sizeSlope = 0;
    sizeSlope = Math.min(0, Math.max(-1.5, sizeSlope));
  }
  return { global, winsorLo, winsorHi, peerCount: peers.length, byCategory, sizeSlope, sizeCenter, growthWeight };
}

/** The multiple one protocol's TVL carries, under a fit and a term set. */
export function multipleFor(
  fit: FittedMultiples,
  category: string | null,
  tvlUsd: number,
  growthPct: number,
  terms: { category: boolean; size: boolean; growth: boolean },
): number {
  let multiple = fit.global;
  if (terms.category) {
    const cat = fit.byCategory[category ?? 'Other'];
    multiple = cat !== undefined ? cat.shrunk : fit.global;
  }
  if (terms.size && fit.sizeSlope !== 0) {
    const factor = Math.exp(fit.sizeSlope * (Math.log(Math.max(1, tvlUsd)) - fit.sizeCenter));
    multiple *= Math.min(2, Math.max(0.25, factor));
  }
  if (terms.growth) {
    const growth = Math.min(60, Math.max(-30, growthPct));
    multiple *= 1 + (growth / 100) * fit.growthWeight;
  }
  return Math.max(0.001, multiple);
}

/** The typical miss of a value model on a test set: exp(median |log(predicted / actual)|), as a multiple. */
export function typicalMiss(predicted: number[], actual: number[]): number {
  const errs = predicted
    .map((p, i) => Math.abs(Math.log(Math.max(1e-9, p) / Math.max(1e-9, actual[i]!))))
    .sort((a, b) => a - b);
  return Math.exp(medianOf(errs, 0));
}

/** Leave-one-out miss of a term set: fit on all but one peer, predict the held-out one's market cap. */
export function looMiss(peers: Peer[], terms: { category: boolean; size: boolean; growth: boolean }, growthWeight: number): number {
  if (peers.length < 10) return Number.POSITIVE_INFINITY;
  const predicted: number[] = [];
  const actual: number[] = [];
  for (let i = 0; i < peers.length; i++) {
    const rest = peers.filter((_, j) => j !== i);
    const fit = fitMultiples(rest, terms.category, terms.size, growthWeight);
    const held = peers[i]!;
    const multiple = multipleFor(fit, held.category, held.tvl_usd, finite(held.change_7d, 0), terms);
    predicted.push(held.tvl_usd * multiple);
    actual.push(held.mcap_usd);
  }
  return typicalMiss(predicted, actual);
}

/** Walk-forward miss: fit on peers listed before the cut, predict the market cap of peers listed after it. */
export function walkForwardMiss(peers: Peer[], terms: { category: boolean; size: boolean; growth: boolean }, growthWeight: number): number {
  const cut = Date.parse(`${WALK_FORWARD_CUT}T00:00:00Z`);
  const train = peers.filter((p) => p.listed_at !== null && Date.parse(`${p.listed_at}T00:00:00Z`) < cut);
  const test = peers.filter((p) => p.listed_at !== null && Date.parse(`${p.listed_at}T00:00:00Z`) >= cut);
  if (train.length < 10 || test.length < 5) return Number.POSITIVE_INFINITY;
  const fit = fitMultiples(train, terms.category, terms.size, growthWeight);
  const predicted = test.map((p) => p.tvl_usd * multipleFor(fit, p.category, p.tvl_usd, finite(p.change_7d, 0), terms));
  return typicalMiss(predicted, test.map((p) => p.mcap_usd));
}

/** One row of the evidence table: a term, its two held-out misses, and whether it earned its place. */
export interface EvidenceRow {
  term: string;
  looMiss: number;
  walkForwardMiss: number;
  decision: 'kept' | 'tested, not kept';
}

/**
 * Forward selection over the value model's terms. Each round tries every term not yet kept and keeps
 * the one that lowers BOTH held-out misses the most; a term that fails either test is left out and the
 * table says so. The growth weight is chosen by the same two tests from a small grid.
 */
export function selectTerms(peers: Peer[]): { terms: { category: boolean; size: boolean; growth: boolean }; growthWeight: number; evidence: EvidenceRow[] } {
  const base = { category: false, size: false, growth: false };
  let bestLoo = looMiss(peers, base, 0);
  let bestWf = walkForwardMiss(peers, base, 0);
  const evidence: EvidenceRow[] = [
    { term: 'flat median multiple', looMiss: bestLoo, walkForwardMiss: bestWf, decision: 'kept' },
  ];
  const terms = { ...base };
  const candidates: Array<{ key: 'category' | 'size' | 'growth'; label: string }> = [
    { key: 'category', label: 'category effect, shrunk' },
    { key: 'size', label: 'size curve, in TVL' },
    { key: 'growth', label: '7-day TVL growth' },
  ];
  let growthWeight = 0;
  for (const cand of candidates) {
    if (cand.key === 'growth') {
      // The growth weight is a grid search: the weight whose two misses are both lowest.
      let bestW = 0;
      let bestPair: [number, number] | null = null;
      for (const w of [0.15, 0.3, 0.5]) {
        const trial = { ...terms, growth: true };
        const loo = looMiss(peers, trial, w);
        const wf = walkForwardMiss(peers, trial, w);
        if (bestPair === null || (loo <= bestPair[0] && wf <= bestPair[1] && (loo < bestPair[0] || wf < bestPair[1]))) {
          bestPair = [loo, wf];
          bestW = w;
        }
      }
      const trial = { ...terms, growth: true };
      const loo = looMiss(peers, trial, bestW);
      const wf = walkForwardMiss(peers, trial, bestW);
      if (loo < bestLoo && wf < bestWf) {
        terms.growth = true;
        growthWeight = bestW;
        bestLoo = loo;
        bestWf = wf;
        evidence.push({ term: `${cand.label} (weight ${bestW})`, looMiss: loo, walkForwardMiss: wf, decision: 'kept' });
      } else {
        evidence.push({ term: `${cand.label} (weight ${bestW})`, looMiss: loo, walkForwardMiss: wf, decision: 'tested, not kept' });
      }
      continue;
    }
    const trial = { ...terms, [cand.key]: true };
    const loo = looMiss(peers, trial, growthWeight);
    const wf = walkForwardMiss(peers, trial, growthWeight);
    if (loo < bestLoo && wf < bestWf) {
      terms[cand.key] = true;
      bestLoo = loo;
      bestWf = wf;
      evidence.push({ term: cand.label, looMiss: loo, walkForwardMiss: wf, decision: 'kept' });
    } else {
      evidence.push({ term: cand.label, looMiss: loo, walkForwardMiss: wf, decision: 'tested, not kept' });
    }
  }
  return { terms, growthWeight, evidence };
}

/** One protocol of the odds universe: what the token-odds fit reads. */
export interface OddsSubject {
  ageDays: number | null;
  family: string;
  hasToken: boolean;
}

/** The family an odds subject belongs to: its category, or 'Other' when the category is rare or absent. */
export function oddsFamily(category: string | null, familyCounts: Map<string, number>): string {
  if (category === null) return 'Other';
  return (familyCounts.get(category) ?? 0) >= 10 ? category : 'Other';
}

/** The token-odds fit: a smoothed rate per age bucket, and a shrunk family adjustment. */
export interface OddsFit {
  globalRate: number;
  buckets: Array<{ lo: number; hi: number; rate: number; n: number }>;
  familyRate: Record<string, number>;
}

/** The age buckets the odds fit uses, in days. */
export const ODDS_BUCKETS: Array<[number, number]> = [
  [0, 90],
  [91, 180],
  [181, 365],
  [366, 730],
  [731, 100000],
];

/** Fit the odds on a subject set: bucket rates smoothed toward the global rate, family rates shrunk the same way. */
export function fitOdds(subjects: OddsSubject[]): OddsFit {
  const n = subjects.length;
  const withToken = subjects.filter((s) => s.hasToken).length;
  const globalRate = n === 0 ? 0.5 : withToken / n;
  const buckets = ODDS_BUCKETS.map(([lo, hi]) => {
    const inBucket = subjects.filter((s) => s.ageDays !== null && s.ageDays >= lo && s.ageDays <= hi);
    const hits = inBucket.filter((s) => s.hasToken).length;
    // Laplace smoothing: 10 pseudo-observations at the global rate keep a small bucket honest.
    const rate = (hits + 10 * globalRate) / (inBucket.length + 10);
    return { lo, hi, rate, n: inBucket.length };
  });
  const familyRate: Record<string, number> = {};
  const byFamily = new Map<string, { hits: number; total: number }>();
  for (const s of subjects) {
    const cur = byFamily.get(s.family) ?? { hits: 0, total: 0 };
    cur.total += 1;
    if (s.hasToken) cur.hits += 1;
    byFamily.set(s.family, cur);
  }
  for (const [family, { hits, total }] of byFamily) {
    familyRate[family] = (hits + 8 * globalRate) / (total + 8);
  }
  return { globalRate, buckets, familyRate };
}

/** The odds a protocol records a token, from its age and family, under a fit. */
export function oddsFor(fit: OddsFit, age: number | null, family: string): number {
  const bucket = fit.buckets.find((b) => age !== null && age >= b.lo && age <= b.hi);
  const base = bucket !== undefined ? bucket.rate : fit.globalRate;
  const fam = fit.familyRate[family];
  const adjusted = fam === undefined ? base : base * (fam / fit.globalRate);
  return Math.min(0.95, Math.max(0.05, adjusted));
}

/** The Brier score of an odds fit on a subject set: lower is better, 0.25 is a coin flip. */
export function brierScore(fit: OddsFit, subjects: OddsSubject[]): number {
  if (subjects.length === 0) return 0.25;
  let sum = 0;
  for (const s of subjects) {
    const p = oddsFor(fit, s.ageDays, s.family);
    sum += (p - (s.hasToken ? 1 : 0)) ** 2;
  }
  return sum / subjects.length;
}

/** Leave-one-out Brier score of the odds fit. */
export function looBrier(subjects: OddsSubject[]): number {
  if (subjects.length < 10) return 0.25;
  let sum = 0;
  for (let i = 0; i < subjects.length; i++) {
    const rest = subjects.filter((_, j) => j !== i);
    const fit = fitOdds(rest);
    const s = subjects[i]!;
    const p = oddsFor(fit, s.ageDays, s.family);
    sum += (p - (s.hasToken ? 1 : 0)) ** 2;
  }
  return sum / subjects.length;
}

/** Walk-forward Brier score: fit on subjects listed before the cut, score the ones listed after it.
 * Note: this test cannot identify an age-based odds model from one snapshot — the pre-cut training
 * set holds no young protocol, so its young-age rates fall back to the global rate. The odds model
 * is therefore validated by leave-one-out and by a deterministic split-half instead. */
export function walkForwardBrier(subjects: Array<OddsSubject & { listedAt: string | null }>): number {
  const cut = Date.parse(`${WALK_FORWARD_CUT}T00:00:00Z`);
  const train = subjects.filter((s) => s.listedAt !== null && Date.parse(`${s.listedAt}T00:00:00Z`) < cut);
  const test = subjects.filter((s) => s.listedAt !== null && Date.parse(`${s.listedAt}T00:00:00Z`) >= cut);
  if (train.length < 10 || test.length < 5) return 0.25;
  const fit = fitOdds(train);
  return brierScore(fit, test);
}

/** Split-half Brier score: fit on the even half of the protocols, score the odd half, and the reverse; the mean. */
export function splitHalfBrier(subjects: Array<OddsSubject & { slug: string }>): number {
  const hash = (slug: string): number => {
    let sum = 0;
    for (let i = 0; i < slug.length; i++) sum += slug.charCodeAt(i);
    return sum % 2;
  };
  const even = subjects.filter((s) => hash(s.slug) === 0);
  const odd = subjects.filter((s) => hash(s.slug) === 1);
  if (even.length < 10 || odd.length < 10) return 0.25;
  return (brierScore(fitOdds(even), odd) + brierScore(fitOdds(odd), even)) / 2;
}

/** A seeded pseudo-random stream, so the bootstrap refits are the same on every run. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** A bootstrap resample of an array: n draws with replacement from the seeded stream. */
export function resample<T>(items: T[], rand: () => number): T[] {
  const out: T[] = [];
  for (let i = 0; i < items.length; i++) out.push(items[Math.floor(rand() * items.length)]!);
  return out;
}

// ---------------------------------------------------------------- farm economics

/** A rough gas price per transaction on a chain, in dollars: the plan's fee arithmetic states it. */
const GAS_USD: Record<string, number> = {
  ethereum: 3.0,
  bitcoin: 2.0,
  tron: 0.5,
  avalanche: 0.2,
  arbitrum: 0.15,
  optimism: 0.1,
  linea: 0.1,
  zksync: 0.1,
  starknet: 0.1,
  bsc: 0.1,
  base: 0.05,
  polygon: 0.05,
  plasma: 0.05,
  monad: 0.05,
  sui: 0.05,
  aptos: 0.05,
  berachain: 0.05,
  sonic: 0.05,
  mantle: 0.05,
  mode: 0.05,
  blast: 0.05,
  fraxtal: 0.05,
  ink: 0.05,
  abstract: 0.05,
  hyperliquid: 0.05,
  sei: 0.02,
  solana: 0.02,
  near: 0.02,
  injective: 0.02,
};

/** The gas price for a chain, defaulting to $0.50 when the chain names no price. */
export function gasFor(chain: string): number {
  return GAS_USD[chain.toLowerCase()] ?? 0.5;
}

/** A dollar figure as $x.xx, or $x when whole. */
export function money(n: number): string {
  return n % 1 === 0 ? `$${n}` : `$${n.toFixed(2)}`;
}

/** A farm step: the action, what it costs, how long it takes, and what it costs in gas and time. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
  mins: number;
  tx: number;
}

/** A playbook step template: slots are {name}, {chain}, {second}, {capital}, {deposit}, {hold}, {gas}. */
export interface PlaybookStep {
  t: string;
  c: string;
  time: string;
  mins: number;
  tx: number;
}

/** Fill a playbook template's slots from a farm context. */
export function fill(template: string, ctx: FarmContext): string {
  return template
    .replaceAll('{name}', ctx.name)
    .replaceAll('{chain}', ctx.chain)
    .replaceAll('{second}', ctx.secondChain)
    .replaceAll('{capital}', String(ctx.capital))
    .replaceAll('{deposit}', money(ctx.deposit))
    .replaceAll('{hold}', String(ctx.holdDays))
    .replaceAll('{gas}', money(ctx.gas));
}

/** Everything a farm plan is derived from: the protocol's own record and its verdict. */
export interface FarmContext {
  name: string;
  chain: string;
  secondChain: string;
  capital: number;
  deposit: number;
  holdDays: number;
  gas: number;
  verdict: 'FARM' | 'MARGINAL' | 'SKIP';
  riskNote: string;
}

/** The playbook family a category belongs to: the first match wins. */
export function familyOf(category: string | null): string {
  const c = (category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'lending';
  if (c.includes('dex') || c.includes('amm') || c.includes('liquidity manager')) return 'dex';
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('basis trading') || c.includes('prediction') || c.includes('options')) return 'perps';
  if (c.includes('yield') || c.includes('leveraged farm') || c.includes('farm')) return 'yield';
  if (c.includes('bridge')) return 'bridge';
  if (c.includes('stak') || c.includes('restak')) return 'staking';
  if (c.includes('rwa')) return 'rwa';
  if (c.includes('insurance')) return 'insurance';
  if (c.includes('curator') || c.includes('allocator') || c.includes('index')) return 'curator';
  if (c.includes('stable')) return 'stable';
  if (c.includes('payment')) return 'payments';
  if (c === 'chain') return 'chain';
  return 'general';
}

/** The exit step, which depends on the verdict the economics gave the protocol. */
function exitStep(ctx: FarmContext): PlaybookStep {
  if (ctx.verdict === 'FARM') {
    return {
      t: 'Exit only if {name} pauses withdrawals or the position turns against you for a full month; otherwise hold to the {hold}-day mark and claim from the protocol’s own page.',
      c: 'about {gas} of gas to unwind',
      time: '10 minutes',
      mins: 10,
      tx: 1,
    };
  }
  if (ctx.verdict === 'MARGINAL') {
    return {
      t: 'Take the position down by half once the modelled drop would cover the fees twice over, and hold the rest to the {hold}-day mark.',
      c: 'about {gas} of gas to unwind half',
      time: '10 minutes',
      mins: 10,
      tx: 1,
    };
  }
  return {
    t: 'Do not chase this one: unwind the position now, the modelled drop does not cover the fees, and keep the wallet ready for a better farm.',
    c: 'about {gas} of gas to unwind',
    time: '10 minutes',
    mins: 10,
    tx: 1,
  };
}

/** The risk step, which carries the protocol's own warning on top of its family's risk. */
function riskStep(text: string, ctx: FarmContext): PlaybookStep {
  return {
    t: `${text}${ctx.riskNote}`,
    c: 'nothing to watch',
    time: '5 minutes a week',
    mins: 5,
    tx: 0,
  };
}

/** The hold step: the same shape in every family, the days from the protocol's age. */
function holdStep(): PlaybookStep {
  return {
    t: 'Hold the position for at least {hold} days so the activity spans more than one snapshot window.',
    c: 'the {deposit} stays in the position',
    time: '{hold} days',
    mins: 0,
    tx: 0,
  };
}

/** The record step, worded for what the family's position leaves behind. */
function recordStep(text: string): PlaybookStep {
  return { t: text, c: 'nothing but the log', time: '5 minutes', mins: 5, tx: 0 };
}

/**
 * A family's playbook: nine steps whose actions differ by family, so no two families farm alike.
 * The dashboard's page carries the same table and regenerates the same steps from the same row.
 */
export function playbook(family: string, ctx: FarmContext): PlaybookStep[] {
  const exit = exitStep(ctx);
  switch (family) {
    case 'lending':
      return [
        { t: 'Open a fresh wallet on {chain} and fund it with {deposit} of USDC, keeping the seed phrase offline and the wallet used for nothing else.', c: 'about {gas} of gas to fund it', time: '10 minutes', mins: 10, tx: 1 },
        { t: 'Supply {deposit} of USDC to {name}’s lending market on {chain} and leave the supply earning.', c: '{deposit} of capital, about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
        { t: 'Borrow a small amount of a stable asset against the supply, then repay it the same week, so the wallet shows both sides of the market.', c: 'about {gas} of gas per leg', time: '10 minutes', mins: 10, tx: 2 },
        { t: 'Each week, adjust the supply or make one borrow and repayment; a wallet that only deposits once looks idle in a later snapshot.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
        holdStep(),
        riskStep('Watch the borrow rate and the collateral factor: if the rate stays above the supply yield for two weeks running, repay the borrow and keep only the supply.', ctx),
        { t: 'After a month, supply on a second market of {name} or on {second} with the same wallet, so the history shows depth rather than a single deposit.', c: 'about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
        exit,
        recordStep('Log every supply, borrow and repayment with its date, hash and dollar value, and the borrow rate on the day; a claim may ask the wallet to prove its history.'),
      ];
    case 'dex':
      return [
        { t: 'Open a fresh wallet on {chain} and fund it with {deposit}, split evenly between USDC and the pool’s other asset.', c: 'about {gas} of gas to fund it', time: '10 minutes', mins: 10, tx: 1 },
        { t: 'Add {deposit} of liquidity to {name}’s main pool on {chain} and hold the LP receipt.', c: '{deposit} of capital, about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
        { t: 'Stake the LP receipt in {name}’s gauge or farm contract if one is live, so the position earns rewards on top of trading fees.', c: 'about {gas} of gas to stake', time: '10 minutes', mins: 10, tx: 1 },
        { t: 'Each week, claim the accrued fees or rewards and re-add them to the pool; a wallet that never compounds looks idle.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
        holdStep(),
        riskStep('Watch impermanent loss: if the pair’s price moves more than a fifth against the deposit, pull half the liquidity and wait for the range to settle.', ctx),
        { t: 'After a month, add liquidity to a second pool of {name} on {chain} or on {second} with the same wallet.', c: 'about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
        exit,
        recordStep('Log the pool, the entry prices, every claim and the LP receipt’s balance; a claim may ask the wallet to prove its history.'),
      ];
    case 'perps':
      return [
        { t: 'Open a fresh wallet on {chain} and fund it with {deposit} of USDC to use as margin, keeping the seed phrase offline.', c: 'about {gas} of gas to fund it', time: '10 minutes', mins: 10, tx: 1 },
        { t: 'Deposit {deposit} of USDC as margin on {name} and open one small position, no more than a tenth of the margin, so a single move cannot liquidate it.', c: '{deposit} of capital, about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
        { t: 'Open a matching hedge on the other side of the same market, or on a second venue, so the position earns funding while its direction stays flat.', c: 'about {gas} of gas to hedge', time: '10 minutes', mins: 10, tx: 1 },
        { t: 'Each week, settle the funding, rebalance the hedge and close one round trip; a wallet that never trades looks idle.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
        holdStep(),
        riskStep('Watch the funding rate and the liquidation price daily while a position is open: if funding turns against the hedge for a week, close it and sit out.', ctx),
        { t: 'After a month, run the same hedged pair on a second market of {name} or on {second} with the same wallet.', c: 'about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
        exit,
        recordStep('Log every entry and exit price, the funding paid and received, and the margin balance; a claim may ask the wallet to prove its history.'),
      ];
    case 'yield':
      return [
        { t: 'Open a fresh wallet on {chain} and fund it with {deposit} of USDC, keeping the seed phrase offline.', c: 'about {gas} of gas to fund it', time: '10 minutes', mins: 10, tx: 1 },
        { t: 'Deposit {deposit} into {name}’s main yield vault on {chain} and hold the vault shares.', c: '{deposit} of capital, about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
        { t: 'Claim the vault’s rewards each week and re-deposit them, so the position compounds instead of sitting still.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
        { t: 'Each week, move a small part of the yield into a second vault of {name} to show the wallet uses more than one strategy.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
        holdStep(),
        riskStep('Read the vault’s strategy page before depositing: if the yield is mostly unlisted points rather than fees, size the first deposit at half the plan.', ctx),
        { t: 'After a month, deposit into a second vault of {name} on {chain} or on {second} with the same wallet.', c: 'about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
        exit,
        recordStep('Log every deposit, claim and re-deposit with its date, hash and dollar value, and the vault’s stated yield on the day.'),
      ];
    case 'bridge':
      return [
        { t: 'Open a fresh wallet on {chain} and fund it with {deposit} of USDC, keeping the seed phrase offline.', c: 'about {gas} of gas to fund it', time: '10 minutes', mins: 10, tx: 1 },
        { t: 'Bridge {deposit} of USDC to {chain} through {name} and use the bridged funds in the destination app the same day.', c: '{deposit} of capital, about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
        { t: 'Bridge a smaller amount back the following week, so the wallet shows two-way volume instead of a single hop.', c: 'about {gas} of gas to bridge back', time: '10 minutes', mins: 10, tx: 1 },
        { t: 'Each week, bridge one modest amount in either direction and use it on the destination chain; a wallet that bridges once looks like a pass-through.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
        holdStep(),
        riskStep('Check finality before bridging: if the destination chain is congested or the bridge pauses, wait rather than paying a second fee to retry.', ctx),
        { t: 'After a month, bridge through {name} to a second destination chain with the same wallet.', c: 'about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
        exit,
        recordStep('Log each bridge’s source and destination hashes, the amount and the fee; a claim may ask the wallet to prove its history.'),
      ];
    case 'staking':
      return [
        { t: 'Open a fresh wallet on {chain} and fund it with {deposit} of the chain’s staking asset, keeping the seed phrase offline.', c: 'about {gas} of gas to fund it', time: '10 minutes', mins: 10, tx: 1 },
        { t: 'Stake {deposit} through {name} on {chain} and keep the staking receipt.', c: '{deposit} of capital, about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
        { t: 'Restake or compound the staking rewards each week into the same position, so the stake grows instead of sitting still.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
        { t: 'Each week, claim and restake the rewards; a wallet that never touches its stake looks idle.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
        holdStep(),
        riskStep('Check the unbonding period before staking: if it is longer than the farm horizon, size the first stake at half the plan.', ctx),
        { t: 'After a month, stake a second tranche through {name} on {chain} or on {second} with the same wallet.', c: 'about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
        exit,
        recordStep('Log every stake, claim and restake with its date, hash and dollar value, and the unbonding period on the day.'),
      ];
    case 'rwa':
      return [
        { t: 'Open a fresh wallet on {chain} and fund it with {deposit} of USDC, keeping the seed phrase offline.', c: 'about {gas} of gas to fund it', time: '10 minutes', mins: 10, tx: 1 },
        { t: 'Mint {deposit} of {name}’s yield asset on {chain} and hold it in the wallet.', c: '{deposit} of capital, about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
        { t: 'Reinvest the yield the asset pays each week back into the same asset, so the holding compounds.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
        { t: 'Each week, claim the yield and mint a little more; a wallet that mints once looks idle.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
        holdStep(),
        riskStep('Read the asset’s backing and redemption terms first: if redemptions pause or the backing is unaudited, size the first mint at half the plan.', ctx),
        { t: 'After a month, mint a second tranche of the asset on {chain} or on {second} with the same wallet.', c: 'about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
        exit,
        recordStep('Log every mint and yield claim with its date, hash and dollar value, and the asset’s backing on the day.'),
      ];
    case 'insurance':
      return [
        { t: 'Open a fresh wallet on {chain} and fund it with {deposit} of USDC, keeping the seed phrase offline.', c: 'about {gas} of gas to fund it', time: '10 minutes', mins: 10, tx: 1 },
        { t: 'Buy {deposit} of cover from {name} on {chain} for a protocol you already use, and keep the policy active.', c: '{deposit} of capital, about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
        { t: 'Renew or top up the cover before it lapses, and file one test claim on a small event if the policy allows it, so the wallet shows a real policyholder.', c: 'about {gas} of gas to renew', time: '10 minutes', mins: 10, tx: 1 },
        { t: 'Each week, check the cover’s status and the protocol it protects; a lapsed policy counts for nothing.', c: 'nothing to check', time: '5 minutes a week', mins: 5, tx: 0 },
        holdStep(),
        riskStep('Read the exclusions before buying: if the cover excludes the exact failure you fear, the premium buys nothing.', ctx),
        { t: 'After a month, buy cover for a second protocol through {name} on {chain} with the same wallet.', c: 'about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
        exit,
        recordStep('Log every policy, premium and claim with its date, hash and dollar value, and the cover’s exclusions on the day.'),
      ];
    case 'curator':
      return [
        { t: 'Open a fresh wallet on {chain} and fund it with {deposit} of USDC, keeping the seed phrase offline.', c: 'about {gas} of gas to fund it', time: '10 minutes', mins: 10, tx: 1 },
        { t: 'Deposit {deposit} into a {name} vault on {chain} and hold the vault shares.', c: '{deposit} of capital, about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
        { t: 'Vote on the vault’s allocation proposals when they open, so the wallet shows governance use as well as a deposit.', c: 'about {gas} of gas to vote', time: '10 minutes', mins: 10, tx: 1 },
        { t: 'Each week, review the vault’s allocation and rebalance or top up a little; a wallet that deposits once looks idle.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
        holdStep(),
        riskStep('Read the vault’s allocation and fee schedule first: if one strategy takes most of the vault, the deposit rides a single bet.', ctx),
        { t: 'After a month, deposit into a second {name} vault on {chain} or on {second} with the same wallet.', c: 'about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
        exit,
        recordStep('Log every deposit, vote and rebalance with its date, hash and dollar value, and the vault’s allocation on the day.'),
      ];
    case 'stable':
      return [
        { t: 'Open a fresh wallet on {chain} and fund it with {deposit} of USDC, keeping the seed phrase offline.', c: 'about {gas} of gas to fund it', time: '10 minutes', mins: 10, tx: 1 },
        { t: 'Mint or deposit {deposit} of the stable asset through {name} on {chain} and hold it.', c: '{deposit} of capital, about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
        { t: 'Use the stable asset in one of {name}’s partner pools each week, so the wallet shows the asset moving, not sitting.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
        { t: 'Each week, move a small amount through the stable asset’s main use; a wallet that mints once looks idle.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
        holdStep(),
        riskStep('Check the peg and the redemption path before minting: if the asset trades off peg or redemptions queue, size the first mint at half the plan.', ctx),
        { t: 'After a month, mint a second tranche through {name} on {chain} or on {second} with the same wallet.', c: 'about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
        exit,
        recordStep('Log every mint, move and redemption with its date, hash and dollar value, and the peg on the day.'),
      ];
    case 'chain':
      return [
        { t: 'Open a fresh wallet on {chain} and fund it with {deposit} of the chain’s native asset, keeping the seed phrase offline.', c: 'about {gas} of gas to fund it', time: '10 minutes', mins: 10, tx: 1 },
        { t: 'Use {deposit} across {name}’s own apps on {chain}: swap, stake and hold, so the wallet touches the chain rather than one app.', c: '{deposit} of capital, about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
        { t: 'Each week, use a different app of {name} on {chain} — a swap, a stake, a vote — so the history shows breadth.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
        { t: 'Each week, make one on-chain action on {chain} through {name}; a wallet that acts once looks idle.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
        holdStep(),
        riskStep('Spread the activity across the chain’s apps: if one app holds all of it, a single outage wipes the record.', ctx),
        { t: 'After a month, bridge a small amount to {name} on {second} and use it there with the same wallet.', c: 'about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
        exit,
        recordStep('Log every app used, with its date, hash and dollar value, so the breadth of the activity is provable.'),
      ];
    case 'payments':
      return [
        { t: 'Open a fresh wallet on {chain} and fund it with {deposit} of USDC, keeping the seed phrase offline.', c: 'about {gas} of gas to fund it', time: '10 minutes', mins: 10, tx: 1 },
        { t: 'Pay {deposit} through {name} on {chain} for a real purchase or transfer, and keep the receipt.', c: '{deposit} of capital, about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
        { t: 'Each week, route one payment through {name} instead of a plain transfer, so the wallet shows repeated use.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
        { t: 'Each week, make one payment through {name}; a wallet that pays once looks idle.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
        holdStep(),
        riskStep('Check the payment’s finality and fee before sending: if the fee eats the payment, wait for a cheaper window.', ctx),
        { t: 'After a month, pay through {name} on {second} with the same wallet.', c: 'about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
        exit,
        recordStep('Log every payment with its date, hash and dollar value, and the receipt; a claim may ask the wallet to prove its history.'),
      ];
    default:
      return [
        { t: 'Open a fresh wallet on {chain} and fund it with {deposit} of USDC, keeping the seed phrase offline.', c: 'about {gas} of gas to fund it', time: '10 minutes', mins: 10, tx: 1 },
        { t: 'Deposit {deposit} of USDC into {name} on {chain} and keep the position open.', c: '{deposit} of capital, about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
        { t: 'Use one more feature of {name} the following week — a swap, a stake or a vote — so the wallet shows more than a deposit.', c: 'about {gas} of gas', time: '10 minutes', mins: 10, tx: 1 },
        { t: 'Each week, make one qualifying action on {name}; a wallet that deposits once looks idle.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
        holdStep(),
        riskStep('Read {name}’s own docs before the second action: if the docs are thin or the app is paused, size the first deposit at half the plan.', ctx),
        { t: 'After a month, use {name} on {second} with the same wallet.', c: 'about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
        exit,
        recordStep('Log every action with its date, hash and dollar value, so the position’s history is provable.'),
      ];
  }
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** A protocol's farm plan: nine steps from its family's playbook, filled from its own record. */
export function farmSteps(p: SnapshotProtocol, age: number | null, ctx: FarmContext): FarmStep[] {
  const family = familyOf(p.category);
  return playbook(family, ctx).map((s) => ({
    text: fill(s.t, ctx),
    cost: fill(s.c, ctx),
    time: fill(s.time, ctx),
    mins: s.mins,
    tx: s.tx,
  }));
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
export function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The deposit a farm position plans: 0.02% of TVL, between $1,000 and $10,000. */
export function depositFor(tvlUsd: number): number {
  return Math.min(10000, Math.max(1000, Math.round(tvlUsd * 0.0002)));
}

/** The risk flags a row carries, each a plain reading of its own figures. */
export function riskFlags(p: SnapshotProtocol, age: number | null, odds: number, p25: number, p75: number, verdict: string): string[] {
  const flags: string[] = [];
  if (p.change_7d !== null && p.change_7d < 0) flags.push(`TVL down ${Math.abs(p.change_7d).toFixed(1)}% in 7 days`);
  if (p.change_7d === null) flags.push('no 7-day growth reported');
  if (p.chains.length <= 1) flags.push('lives on one chain');
  if (age !== null && age < 180) flags.push(`listed under 6 months ago (${age} days)`);
  if (age === null) flags.push('listing date unknown');
  if (odds < 0.6) flags.push(`token odds under 60% (${Math.round(odds * 100)}%)`);
  if (p25 > 0 && p75 / p25 > 2) flags.push('implied range spans more than 2x');
  if (verdict === 'SKIP') flags.push('farm economics do not clear the fees');
  return flags.slice(0, 4);
}

// ---------------------------------------------------------------- the board

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  group: 'watchlist' | 'early' | 'off-list';
  age_days: number | null;
  implied_value_usd: number;
  if_launches_usd: number;
  token_odds: number;
  p25_usd: number;
  p75_usd: number;
  p10_usd: number;
  p90_usd: number;
  rank_lo: number;
  rank_hi: number;
  multiple: number;
  category_multiple: number;
  size_factor: number;
  growth_factor: number;
  verdict: 'FARM' | 'MARGINAL' | 'SKIP';
  deposit_usd: number;
  drop_usd: number;
  fees_usd: number;
  net_usd: number;
  net_per_hour_usd: number;
  tbill_usd: number;
  hours: number;
  risk_flags: string[];
  rank_reason: string;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** A protocol set aside, with the plain reason it is not a launch candidate. */
export interface SetAsideRow {
  slug: string;
  name: string;
  category: string | null;
  reason: string;
}

/** Everything the dashboard renders, from the snapshot and the fitted model. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  counts: { protocols: number; watchlist: number; ranked: number; early: number; offList: number; live: number; setAside: number };
  fit: { globalMultiple: number; winsorLo: number; winsorHi: number; peerCount: number; sizeSlope: number; sizeCenterTvl: number; growthWeight: number; termsUsed: string[]; terms: { category: boolean; size: boolean; growth: boolean } };
  evidence: EvidenceRow[];
  odds: { globalRate: number; buckets: Array<{ lo: number; hi: number; rate: number; n: number }>; brierBase: number; brierFit: number; brierLoo: number; brierSplit: number };
  calibration: { looMiss: number; walkForwardMiss: number; inP25P75: number; inP10P90: number };
  verdicts: { farm: number; marginal: number; skip: number };
  rows: BoardRow[];
  live: LiveRow[];
  setAside: SetAsideRow[];
  peers: Array<{ slug: string; name: string; category: string | null; tvl_usd: number; mcap_usd: number }>;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** The protocols set aside, each with the plain reason, in snapshot order. */
export function setAsideRows(snapshot: Snapshot): SetAsideRow[] {
  return snapshot.protocols
    .filter((p) => isPreToken(p) && !isRankable(p))
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, reason: setAsideReason(p) ?? 'set aside' }));
}

/** One sentence saying why a row ranks where it does, from its own figures. */
export function rankReason(row: { tvl_usd: number; multiple: number; token_odds: number; implied_value_usd: number; rank: number; category: string | null }): string {
  const tvl = row.tvl_usd >= 1e9 ? `$${(row.tvl_usd / 1e9).toFixed(2)}B of TVL` : `$${Math.round(row.tvl_usd / 1e6)}M of TVL`;
  return `Rank ${row.rank} on ${tvl} at a ${row.multiple.toFixed(2)} fitted multiple and ${Math.round(row.token_odds * 100)}% token odds, for $${Math.round(row.implied_value_usd).toLocaleString('en-US')} of implied value.`;
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const peers = tradedPeers(snapshot);
  const { terms, growthWeight, evidence } = selectTerms(peers);
  const fit = fitMultiples(peers, terms.category, terms.size, growthWeight);
  const finalLoo = evidence.filter((e) => e.decision === 'kept').reduce((m, e) => Math.min(m, e.looMiss), Number.POSITIVE_INFINITY);
  const finalWf = evidence.filter((e) => e.decision === 'kept').reduce((m, e) => Math.min(m, e.walkForwardMiss), Number.POSITIVE_INFINITY);

  // The odds universe: every protocol that could plausibly be a radar subject, exchanges and wrapped
  // products left out, so the odds answer "does a protocol like this one record a token", not "does
  // an exchange have one".
  const familyCounts = new Map<string, number>();
  for (const p of snapshot.protocols) {
    if (p.category === 'CEX' || WRAPPED_CATEGORIES.has(p.category ?? '')) continue;
    familyCounts.set(p.category ?? 'Other', (familyCounts.get(p.category ?? 'Other') ?? 0) + 1);
  }
  const oddsSubjects: Array<OddsSubject & { listedAt: string | null; slug: string }> = snapshot.protocols
    .filter((p) => p.category !== 'CEX' && !WRAPPED_CATEGORIES.has(p.category ?? ''))
    .map((p) => ({
      slug: p.slug,
      ageDays: ageDays(snapshot.as_of, p.listed_at),
      family: oddsFamily(p.category, familyCounts),
      hasToken: !isPreToken(p),
      listedAt: p.listed_at,
    }));
  const oddsFit = fitOdds(oddsSubjects);
  const brierFit = brierScore(oddsFit, oddsSubjects);
  const baseFit: OddsFit = { globalRate: oddsFit.globalRate, buckets: ODDS_BUCKETS.map(([lo, hi]) => ({ lo, hi, rate: oddsFit.globalRate, n: 0 })), familyRate: {} };
  const brierBase = brierScore(baseFit, oddsSubjects);
  const brierLoo = looBrier(oddsSubjects);
  const brierSplit = splitHalfBrier(oddsSubjects);

  // The board: every rankable protocol, watchlist first by rule, then the early and off-list rows.
  const watchlist = new Set(snapshot.watchlist);
  const ranked = snapshot.protocols.filter((p) => isRankable(p));
  const growthOf = (p: SnapshotProtocol): number => finite(p.change_7d, 0);

  interface Scored {
    p: SnapshotProtocol;
    age: number | null;
    multiple: number;
    catMultiple: number;
    sizeFactor: number;
    growthFactor: number;
    ifLaunches: number;
    odds: number;
    implied: number;
  }
  const scoreOne = (p: SnapshotProtocol, f: FittedMultiples, o: OddsFit): Scored => {
    const age = ageDays(snapshot.as_of, p.listed_at);
    const multiple = multipleFor(f, p.category, p.tvl_usd, growthOf(p), terms);
    const catMultiple = terms.category ? (f.byCategory[p.category ?? 'Other']?.shrunk ?? f.global) : f.global;
    const sizeFactor = terms.size && f.sizeSlope !== 0 ? Math.min(2, Math.max(0.25, Math.exp(f.sizeSlope * (Math.log(Math.max(1, p.tvl_usd)) - f.sizeCenter)))) : 1;
    const growthFactor = terms.growth ? 1 + (Math.min(60, Math.max(-30, growthOf(p))) / 100) * f.growthWeight : 1;
    const ifLaunches = Math.max(1, Math.round(p.tvl_usd * multiple));
    const odds = oddsFor(o, age, oddsFamily(p.category, familyCounts));
    const implied = Math.max(1, Math.round(ifLaunches * odds));
    return { p, age, multiple, catMultiple, sizeFactor, growthFactor, ifLaunches, odds, implied };
  };

  const scored = ranked.map((p) => scoreOne(p, fit, oddsFit));
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  // The bootstrap: refit the multiples and the odds on resampled peers and subjects, 200 times, and
  // read each row's implied range and rank range off the refits. One seeded stream, so every run agrees.
  // The residuals of the full fit on the traded peers: log(actual / predicted). The bootstrap
  // ranges are predictive — each refit's implied value also draws one residual — so the printed
  // range covers the spread of real outcomes, not just the fit's own wobble.
  const residuals = peers.map((p) => Math.log(p.mcap_usd / Math.max(1, p.tvl_usd * multipleFor(fit, p.category, p.tvl_usd, finite(p.change_7d, 0), terms))));
  const rand = seededRandom(20261114);
  const bootImplied = new Map<string, number[]>();
  const bootRank = new Map<string, number[]>();
  for (const s of scored) {
    bootImplied.set(s.p.slug, []);
    bootRank.set(s.p.slug, []);
  }
  for (let rep = 0; rep < BOOTSTRAP_REPS; rep++) {
    const bootPeers = resample(peers, rand);
    const bootFit = fitMultiples(bootPeers, terms.category, terms.size, growthWeight);
    const bootSubjects = resample(oddsSubjects, rand);
    const bootOdds = fitOdds(bootSubjects);
    const repScored = ranked.map((p) => scoreOne(p, bootFit, bootOdds));
    repScored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
    // Ranks come from the clean refit; the implied values carry one residual draw each, so the
    // printed range is a predictive interval.
    repScored.forEach((s, i) => {
      bootRank.get(s.p.slug)!.push(i + 1);
    });
    for (const s of repScored) {
      const draw = residuals[Math.floor(rand() * residuals.length)]!;
      bootImplied.get(s.p.slug)!.push(Math.max(1, Math.round(s.implied * Math.exp(draw))));
    }
  }
  const rangeOf = (values: number[], q: number): number => {
    const sorted = [...values].sort((a, b) => a - b);
    return quantileOf(sorted, q);
  };

  const board: BoardRow[] = scored.map((s, i) => {
    const p = s.p;
    const group: 'watchlist' | 'early' | 'off-list' = watchlist.has(p.slug) ? 'watchlist' : p.tvl_usd < snapshot.floor_usd ? 'early' : 'off-list';
    const implieds = bootImplied.get(p.slug)!;
    const ranks = bootRank.get(p.slug)!;
    const p25 = Math.max(1, Math.round(rangeOf(implieds, 0.25)));
    const p75 = Math.max(1, Math.round(rangeOf(implieds, 0.75)));
    const p10 = Math.max(1, Math.round(rangeOf(implieds, 0.1)));
    const p90 = Math.max(1, Math.round(rangeOf(implieds, 0.9)));
    const rankLo = Math.round(rangeOf(ranks, 0.1));
    const rankHi = Math.round(rangeOf(ranks, 0.9));

    // Farm economics for this row: a deposit of 0.02% of TVL, a drop modelled as a share of the
    // implied value in proportion to the deposit's share of TVL, minus the plan's own gas.
    const deposit = depositFor(p.tvl_usd);
    const drop = Math.round(s.implied * DROP_SHARE * (deposit / p.tvl_usd) * 100) / 100;
    const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
    const secondChain = p.chains.length > 1 ? p.chains[1]! : chain;
    const gas = gasFor(chain);
    const hold = holdDaysFor(s.age);
    const capital = deposit;
    const riskNote = riskFlags(p, s.age, s.odds, p25, p75, 'MARGINAL').length > 0 ? ` ${riskFlags(p, s.age, s.odds, p25, p75, 'MARGINAL')[0]!}.` : '';
    // The verdict needs the fees, and the fees need the plan; build the plan once with a provisional
    // verdict, price it, then rebuild it with the verdict the price earns.
    const provisional: FarmContext = { name: p.name, chain, secondChain, capital, deposit, holdDays: hold, gas, verdict: 'MARGINAL', riskNote };
    const provisionalSteps = farmSteps(p, s.age, provisional);
    const fees = Math.round(provisionalSteps.reduce((n, st) => n + st.tx * gas, 0) * 100) / 100;
    const hours = Math.round(provisionalSteps.reduce((n, st) => n + st.mins, 0) / 60 * 10) / 10;
    const tbill = Math.round(deposit * TBILL_RATE * (HORIZON_WEEKS / 52) * 100) / 100;
    const net = Math.round((drop - fees) * 100) / 100;
    const netPerHour = hours > 0 ? Math.round((net / hours) * 100) / 100 : 0;
    const verdict: 'FARM' | 'MARGINAL' | 'SKIP' = net > tbill && netPerHour >= FARM_HOURLY_BAR ? 'FARM' : net > 0 ? 'MARGINAL' : 'SKIP';
    const ctx: FarmContext = { ...provisional, verdict };
    const steps = farmSteps(p, s.age, ctx).map(stepText);
    const flags = riskFlags(p, s.age, s.odds, p25, p75, verdict);
    return {
      rank: i + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd,
      listed_at: p.listed_at,
      gecko_id: p.gecko_id,
      symbol: p.symbol,
      token_status: 'pre-token',
      group,
      age_days: s.age,
      implied_value_usd: s.implied,
      if_launches_usd: s.ifLaunches,
      token_odds: s.odds,
      p25_usd: p25,
      p75_usd: p75,
      p10_usd: p10,
      p90_usd: p90,
      rank_lo: rankLo,
      rank_hi: rankHi,
      multiple: s.multiple,
      category_multiple: s.catMultiple,
      size_factor: s.sizeFactor,
      growth_factor: s.growthFactor,
      verdict,
      deposit_usd: deposit,
      drop_usd: drop,
      fees_usd: fees,
      net_usd: net,
      net_per_hour_usd: netPerHour,
      tbill_usd: tbill,
      hours,
      risk_flags: flags,
      rank_reason: '',
      farm_steps: steps,
    };
  });
  for (const row of board) {
    row.rank_reason = rankReason({ tvl_usd: row.tvl_usd, multiple: row.multiple, token_odds: row.token_odds, implied_value_usd: row.implied_value_usd, rank: row.rank, category: row.category });
  }

  // Range honesty, done properly: for each traded peer, the bootstrap multiples give a predicted
  // market-cap range, each refit drawing one residual as well, so the range is predictive; count
  // how often the actual cap falls inside it.
  let inside2575 = 0;
  let inside1090 = 0;
  {
    const bootPredicted = new Map<string, number[]>();
    const rand2 = seededRandom(20261114);
    for (let rep = 0; rep < BOOTSTRAP_REPS; rep++) {
      const bootPeers = resample(peers, rand2);
      const bootFit = fitMultiples(bootPeers, terms.category, terms.size, growthWeight);
      for (const peer of peers) {
        const m = multipleFor(bootFit, peer.category, peer.tvl_usd, finite(peer.change_7d, 0), terms);
        const draw = residuals[Math.floor(rand2() * residuals.length)]!;
        const arr = bootPredicted.get(peer.slug) ?? [];
        arr.push(peer.tvl_usd * m * Math.exp(draw));
        bootPredicted.set(peer.slug, arr);
      }
    }
    for (const peer of peers) {
      const vs = [...(bootPredicted.get(peer.slug) ?? [])].sort((a, b) => a - b);
      if (vs.length === 0) continue;
      const lo25 = quantileOf(vs, 0.25);
      const hi75 = quantileOf(vs, 0.75);
      const lo10 = quantileOf(vs, 0.1);
      const hi90 = quantileOf(vs, 0.9);
      if (peer.mcap_usd >= lo25 && peer.mcap_usd <= hi75) inside2575++;
      if (peer.mcap_usd >= lo10 && peer.mcap_usd <= hi90) inside1090++;
    }
  }
  const calibration = {
    looMiss: finalLoo,
    walkForwardMiss: finalWf,
    inP25P75: peers.length === 0 ? 0 : round4(inside2575 / peers.length),
    inP10P90: peers.length === 0 ? 0 : round4(inside1090 / peers.length),
  };

  const termsUsed = evidence.filter((e) => e.decision === 'kept').map((e) => e.term);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    counts: {
      protocols: snapshot.protocols.length,
      watchlist: snapshot.watchlist.length,
      ranked: board.length,
      early: board.filter((r) => r.group === 'early').length,
      offList: board.filter((r) => r.group === 'off-list').length,
      live: liveRows(snapshot).length,
      setAside: setAsideRows(snapshot).length,
    },
    fit: {
      globalMultiple: round4(fit.global),
      winsorLo: round4(fit.winsorLo),
      winsorHi: round4(fit.winsorHi),
      peerCount: fit.peerCount,
      sizeSlope: round4(fit.sizeSlope),
      sizeCenterTvl: Math.round(Math.exp(fit.sizeCenter)),
      growthWeight,
      termsUsed,
      terms: { category: terms.category, size: terms.size, growth: terms.growth },
    },
    evidence,
    odds: { globalRate: round4(oddsFit.globalRate), buckets: oddsFit.buckets, brierBase: round4(brierBase), brierFit: round4(brierFit), brierLoo: round4(brierLoo), brierSplit: round4(brierSplit) },
    calibration,
    verdicts: {
      farm: board.filter((r) => r.verdict === 'FARM').length,
      marginal: board.filter((r) => r.verdict === 'MARGINAL').length,
      skip: board.filter((r) => r.verdict === 'SKIP').length,
    },
    rows: board,
    live: liveRows(snapshot),
    setAside: setAsideRows(snapshot),
    peers: peers.map((p) => ({ slug: p.slug, name: snapshot.protocols.find((q) => q.slug === p.slug)?.name ?? p.slug, category: p.category, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd })),
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
