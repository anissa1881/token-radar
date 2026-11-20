// Token Radar's scoring model, version radar-2.
//
// One sealed snapshot in, one ranked board out. The board covers every slug on the snapshot's
// watchlist (the floor, never the ceiling) and adds every pre-token protocol below the floor that
// survives the structural filter. Protocols that look like wrapped, staked or bridged products of a
// token that already trades are set aside with a reason, never ranked as launch candidates.
// Protocols whose token already trades are shown apart, at the market's own value.
//
// Implied value is computed from the snapshot's own figures only, never from a list of names:
//
//   ratio(cat)   median mcap/TVL of the category's token-having protocols, shrunk toward the
//                global median with 8 pseudo-counts, then clamped to [0.02, 1.5]
//   peer growth  the protocol's 7d change minus its category's median 7d change, clamped to
//                [-30, +50] points; multiplier 1 + 0.8 x peer growth / 100
//   maturity     0.65 + 0.35 x min(age_days, 1095) / 1095 (unknown age: 0.80)
//   implied      round(tvl_usd x ratio x growth multiplier x maturity multiplier), at least $1
//
// Every constant is computed or stated here and shown on the dashboard; the dashboard recomputes
// each row from the same figures, so the page and board.json always agree.

/** One protocol entry: exactly the ten fields the sealed snapshot carries. */
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

/** The whole sealed snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's tunable constants. The dashboard prints them next to the formula. */
export interface ModelParams {
  shrink_counts: number;
  ratio_floor: number;
  ratio_cap: number;
  growth_weight: number;
  peer_diff_floor: number;
  peer_diff_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_maturity: number;
  early_cap: number;
  live_cap: number;
}

export const PARAMS: ModelParams = {
  shrink_counts: 8,
  ratio_floor: 0.02,
  ratio_cap: 1.5,
  growth_weight: 0.8,
  peer_diff_floor: -30,
  peer_diff_cap: 50,
  maturity_floor: 0.65,
  maturity_range: 0.35,
  maturity_days: 1095,
  unknown_age_maturity: 0.8,
  early_cap: 160,
  live_cap: 24,
};

/** The model's version label, printed on the dashboard. */
export const MODEL_VERSION = 'radar-2';

/** One category's calibration: how its traded tokens price TVL, and how its TVL is moving. */
export interface CategoryCalibration {
  category: string;
  traded_count: number;
  median_ratio: number | null;
  ratio: number;
  median_growth: number | null;
}

/** The calibration of the whole snapshot: one global ratio, one row per category. */
export interface Calibration {
  global_ratio: number;
  categories: CategoryCalibration[];
}

/** One farm step: the action, what it costs, how long it takes. */
export interface FarmStep {
  action: string;
  cost: string;
  time: string;
}

/** One row of board.json. */
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
  age_days: number | null;
  implied_value_usd: number;
  model: {
    ratio: number;
    ratio_n: number;
    peer_growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact form of one board row; the page regenerates the farm plan from it. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  implied_value_usd: number;
  ratio: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  peer_growth_pct: number;
}

/** A protocol whose token already trades: the market's value, never a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** A pre-token protocol set aside by the structural filter, with its reason. */
export interface SetAsideRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  reason: string;
}

/** Everything the dashboard renders. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelParams;
  model_version: string;
  global_ratio: number;
  calibration: CategoryCalibration[];
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  set_aside_size: number;
  rows: RadarRow[];
  live: LiveRow[];
  set_aside: SetAsideRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** The median of a list of numbers, or null when the list is empty. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A finite number, else the fallback. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `listed` to `asOf`, clamped at zero; null when either date is missing or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol's record carries no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Categories that are a wrapped, staked or bridged product by construction. */
const PRODUCT_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Cross Chain Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'Staking Pool',
  'CEX',
]);

/** A name ending in a release marker is a pool of another protocol, not a launch of its own. */
const VERSION_MARKER = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Exchange names a protocol must not start with: it is that exchange's product. */
const EXCHANGE_PREFIXES = ['binance', 'coinbase', 'bybit', 'kraken', 'bitget', 'okx', 'bitfinex', 'gemini'];

/**
 * Why a protocol is set aside instead of ranked, or null when it may be ranked. The rule is
 * structural — category, name shape, exchange prefix — never the protocol's name itself.
 */
export function setAsideReason(p: SnapshotProtocol): string | null {
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) {
    return `Category ${p.category} is a wrapped, staked or bridged product of a token that already trades`;
  }
  const words = p.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.includes('wrapped') || words.includes('staked') || words.includes('staking')) {
    return 'Name marks it a wrapped or staked product of a token that already trades';
  }
  if (VERSION_MARKER.test(p.name)) {
    return 'Name ends in a version marker, so it is a pool of another protocol';
  }
  const lower = p.name.toLowerCase();
  for (const exchange of EXCHANGE_PREFIXES) {
    if (lower.startsWith(exchange)) return `Name starts with ${exchange}, so it is that exchange's product`;
  }
  return null;
}

/** Whether a protocol may be ranked: pre-token and not set aside by the structural filter. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && setAsideReason(p) === null;
}

/**
 * The calibration: the global median mcap/TVL over every protocol whose token trades, and one row
 * per category with its own median ratio shrunk toward the global one. A category with few traded
 * protocols barely moves the global figure; a category with none uses it outright.
 */
export function calibrate(snapshot: Snapshot, params: ModelParams = PARAMS): Calibration {
  const traded = snapshot.protocols.filter(
    (p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
  const global = median(traded.map((p) => p.mcap_usd! / p.tvl_usd)) ?? 0.2;

  const byCategory = new Map<string, SnapshotProtocol[]>();
  for (const p of snapshot.protocols) {
    const key = p.category ?? 'Other';
    const list = byCategory.get(key) ?? [];
    list.push(p);
    byCategory.set(key, list);
  }

  const categories: CategoryCalibration[] = [];
  for (const [category, members] of [...byCategory.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const catTraded = members.filter(
      (p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
    );
    const catMedian = median(catTraded.map((p) => p.mcap_usd! / p.tvl_usd));
    const n = catTraded.length;
    const shrunk =
      catMedian === null
        ? global
        : (n * catMedian + params.shrink_counts * global) / (n + params.shrink_counts);
    const ratio = Math.min(params.ratio_cap, Math.max(params.ratio_floor, shrunk));
    const growths = members.map((p) => p.change_7d).filter((g): g is number => g !== null);
    categories.push({
      category,
      traded_count: n,
      median_ratio: catMedian === null ? null : Math.round(catMedian * 1e4) / 1e4,
      ratio: Math.round(ratio * 1e4) / 1e4,
      median_growth: median(growths) === null ? null : Math.round(median(growths)! * 100) / 100,
    });
  }
  return { global_ratio: Math.round(global * 1e4) / 1e4, categories };
}

/** The ratio a category scores with, from the calibration table. */
function ratioFor(calibration: Calibration, category: string | null): { ratio: number; n: number } {
  const row = calibration.categories.find((c) => c.category === (category ?? 'Other'));
  if (row === undefined) return { ratio: calibration.global_ratio, n: 0 };
  return { ratio: row.ratio, n: row.traded_count };
}

/** The median 7d change of a category's protocols, or null when the category reports none. */
function peerGrowthFor(calibration: Calibration, category: string | null): number | null {
  const row = calibration.categories.find((c) => c.category === (category ?? 'Other'));
  return row === undefined ? null : row.median_growth;
}

/** A protocol's score under the model: its implied value and every factor behind it. */
export function scoreProtocol(
  p: SnapshotProtocol,
  snapshot: Snapshot,
  calibration: Calibration,
  params: ModelParams = PARAMS,
): {
  implied: number;
  ratio: number;
  ratioN: number;
  peerGrowth: number;
  growthMult: number;
  maturityMult: number;
  age: number | null;
} {
  const { ratio, n } = ratioFor(calibration, p.category);
  const peerMedian = peerGrowthFor(calibration, p.category);
  const own = finite(p.change_7d, peerMedian ?? 0);
  const diff = own - (peerMedian ?? 0);
  const peerGrowth = Math.min(params.peer_diff_cap, Math.max(params.peer_diff_floor, diff));
  const growthMult = 1 + (peerGrowth / 100) * params.growth_weight;
  const age = ageDays(snapshot.as_of, p.listed_at);
  const maturityMult =
    age === null
      ? params.unknown_age_maturity
      : params.maturity_floor +
        (Math.min(Math.max(age, 0), params.maturity_days) / params.maturity_days) * params.maturity_range;
  const implied = Math.max(1, Math.round(p.tvl_usd * ratio * growthMult * maturityMult));
  return { implied, ratio, ratioN: n, peerGrowth, growthMult, maturityMult, age };
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, calibration: Calibration, params: ModelParams = PARAMS): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug it names, even one the snapshot no longer carries.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: rankable pre-token protocols below the floor, by TVL, capped. A chosen
  // protocol stays chosen; the filter, not a hand-picked list, decides what joins.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, params.early_cap);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const s = scoreProtocol(p, snapshot, calibration, params);
    return { p, ...s };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token' as const,
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      ratio: s.ratio,
      ratio_n: s.ratioN,
      peer_growth_pct: round4(s.peerGrowth),
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

/** The pre-token protocols the structural filter set aside, with their reasons. */
export function setAsideRows(snapshot: Snapshot): SetAsideRow[] {
  return snapshot.protocols
    .filter((p) => isPreToken(p) && setAsideReason(p) !== null)
    .sort((a, b) => b.tvl_usd - a.tvl_usd)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      reason: setAsideReason(p)!,
    }));
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot, params: ModelParams = PARAMS): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, params.live_cap)
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

/** A board row's compact form for data.js; the page regenerates the farm plan from it. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    ratio: row.model.ratio,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    peer_growth_pct: row.model.peer_growth_pct,
  };
}

/** Everything the dashboard renders, from one snapshot. */
export function buildRadar(
  snapshot: Snapshot,
  params: ModelParams = PARAMS,
): { board: BoardRow[]; radar: RadarData } {
  const calibration = calibrate(snapshot, params);
  const board = buildBoard(snapshot, calibration, params);
  const live = liveRows(snapshot, params);
  const setAside = setAsideRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: params,
    model_version: MODEL_VERSION,
    global_ratio: calibration.global_ratio,
    calibration: calibration.categories,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    set_aside_size: setAside.length,
    rows: board.map(radarRow),
    live,
    set_aside: setAside,
  };
  return { board, radar };
}

/** One farm step as a single string: the action, then its cost and time, 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.action} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase when it names none. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** What one transaction costs on a chain: cheap rollups, dear layer ones, the rest in between. */
function gasTier(chain: string): string {
  const cheap = ['arbitrum', 'optimism', 'base', 'polygon', 'zksync', 'blast', 'linea', 'scroll', 'starknet', 'mantle', 'mode', 'ink'];
  const dear = ['ethereum', 'bitcoin'];
  const lower = chain.toLowerCase();
  if (dear.some((d) => lower.includes(d))) return 'about $4 to $12 of gas per transaction';
  if (cheap.some((c) => lower.includes(c))) return 'under $1 of gas per transaction';
  return 'about $1 to $4 of gas per transaction';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 150;
  if (p.tvl_usd >= 50_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The main action for a protocol's category, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Lend $${capital} of USDC on ${name} (${chain}) and leave the loan open so the position stays counted.`;
  }
  if (c.includes('dex') || c.includes('amm') || c.includes('liquidity manager')) {
    return `Add $${capital} of liquidity to the busiest ${name} pool on ${chain} and keep it in range.`;
  }
  if (c.includes('yield') || c.includes('leveraged farm') || c.includes('farm')) {
    return `Put $${capital} into ${name}'s main yield position on ${chain} and let it compound.`;
  }
  if (c.includes('bridge') || c.includes('cross chain')) {
    return `Move $${capital} of USDC onto ${chain} through ${name}, then use the bridged funds inside its app.`;
  }
  if (c.includes('staking') || c.includes('restak')) {
    return `Stake $${capital} of the chain's native asset through ${name} and hold the receipt token.`;
  }
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) {
    return `Post $${capital} of USDC as margin on ${name} and open one small hedged position.`;
  }
  if (c.includes('prediction')) {
    return `Fund $${capital} on ${name} and take one position in an open market.`;
  }
  if (c.includes('curator') || c.includes('allocator') || c.includes('vault')) {
    return `Deposit $${capital} into a ${name} vault on ${chain} and hold the vault shares.`;
  }
  if (c.includes('stable')) {
    return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  }
  if (c.includes('rwa')) {
    return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  }
  if (c.includes('launchpad')) {
    return `Join ${name}'s next sale on ${chain} with $${capital} and hold the allocation.`;
  }
  if (c.includes('payment')) {
    return `Route $${capital} of payments through ${name} on ${chain} over the next month.`;
  }
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written list.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasTier(chain);
  return [
    {
      action: 'Open a fresh wallet that holds only the funds you plan to farm, and store its seed phrase offline where nobody else can read it.',
      cost: 'no fee to open, and the seed costs nothing to store',
      time: '5 minutes',
    },
    {
      action: actionFor(p, capital, chain),
      cost: `$${capital} of capital and ${gas}`,
      time: '15 minutes to set up',
    },
    {
      action: 'Do one qualifying action every week, such as a deposit, a borrow, a swap or a vote, so the wallet keeps showing up.',
      cost: gas.replace('per transaction', 'a week'),
      time: '10 minutes a week',
    },
    {
      action: `Leave the position alone for at least ${hold} days so the activity spans more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      action: 'Before you withdraw, open the protocol’s own points or rewards page and claim only from the link that page itself publishes.',
      cost: 'no fee to check, and never pay anyone to claim for you',
      time: '10 minutes',
    },
    {
      action: 'Write the wallet address, the dates and every transaction hash in a farm log, so you can repeat the position or unwind it later.',
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError('snapshot.json is not a JSON object');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) {
    throw new SnapshotError('snapshot.json has no as_of date');
  }
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    }
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
  if (missing.length > 0) {
    return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  }
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) {
      return `row ${i + 1} outranks row ${i} on implied value`;
    }
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      return `${r.slug} has ${r.farm_steps.length} farm steps`;
    }
    for (const s of r.farm_steps) {
      if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
