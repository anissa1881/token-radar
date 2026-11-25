// Token Radar, model radar-4. Fits a value model and a token-odds model fresh
// from the sealed DefiLlama snapshot, ranks every clean pre-token protocol by
// implied value, and writes the board the dashboard reads. Node 22 stdlib only.
//
// Value model (fitted on the 95 priced peers that carry a listing date):
//   log10(market cap) ~ 1 + (log10 TVL - 8) + max(0, log10 TVL - 9)
//                       + clipped 7-day change + shrunk category effect.
// A term stays only when it cuts the median held-out miss in all four tests:
// leave-one-out, walk-forward (earlier listings price later ones), ten-fold,
// and older-to-newer (listed before 2024 prices those listed after).
//   Fitted on this snapshot: LOO x2.56, walk-forward x2.48, ten-fold x2.85,
//   older-to-newer x2.60 (flat median multiple: x4.89 / x5.33).
//
// Token odds (survival): a protocol that has run `a` years with no token
// lists one eventually with probability (L - P(a)) / (1 - P(a)), where
// P(a) = L * (1 - exp(-k a)) is the fitted cumulative listing curve
// (L = 0.85 eventual rate, k = 0.55 per year, maximum likelihood on the
// 645 dated protocols). Size does not move the rate once age is known
// (age 1-2y: big protocols 0.42, small 0.35; age 3y+: big 0.77, small 0.81),
// and the category rates are confounded by youth (Risk Curators: median age
// 0.5y, a single member aged 2y+ and it has a token), so the board uses the
// pooled hazard and says so. A richer logistic (age, size, category) scores
// Brier 0.191 in-sample / 0.206 ten-fold on the same 645; the survival curve
// alone scores 0.224, which the board shows beside it.
//
// Farm verdicts: a row farms when the modelled drop, net of gas, beats both
// a 4% T-bill on the same deposit and $25 an hour of hands-on work. The plan
// is sized to the smallest deposit that turns the row FARM (grid $500 to
// $100,000); a row no deposit can turn is planned at $10,000 and marked by
// what it clears. Drop = 7% of implied value x deposit / (TVL + deposit).
// Gas is charged for the six deposit-path transactions at the deposit
// chain's rate (Ethereum $2.00, Solana $0.01, anything else $0.05).

import { createHash } from 'node:crypto';

export const MODEL_VERSION = 'radar-4';
export const SNAPSHOT_FLOOR_USD = 50_000_000;

// ------------------------------------------------------------------ snapshot

export interface Proto {
  slug: string;
  name: string;
  cat: string;
  chains: string[];
  tvl: number;
  g7: number | null;
  mcap: number | null;
  listedAt: string | null;
  age: number | null;
  hasToken: boolean;
}

export interface Snapshot {
  asOf: string;
  floor: number;
  protocols: Proto[];
  watchlist: string[];
}

const EXCHANGES = ['binance', 'coinbase', 'bybit', 'kraken', 'bitget', 'okx', 'bitfinex', 'gemini'];
const VERSION_TAIL = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** The house list's own exclusion rule, from the snapshot's own fields. */
export function exclusionGroup(p: Proto): 'bridge' | 'liquid-staking' | 'exchange' | 'versioned-or-wrapped' | null {
  if (p.cat === 'Bridge' || p.cat === 'Canonical Bridge') return 'bridge';
  if (p.cat === 'Liquid Staking' || p.cat === 'Liquid Restaking' || p.cat === 'Restaked BTC') return 'liquid-staking';
  if (p.cat === 'CEX' || EXCHANGES.some((e) => p.name.toLowerCase().startsWith(e))) return 'exchange';
  if (VERSION_TAIL.test(p.name) || WRAPPED_WORD.test(p.name)) return 'versioned-or-wrapped';
  return null;
}

export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as {
    as_of: string;
    floor_usd: number;
    watchlist: string[];
    protocols: Array<{
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
    }>;
  };
  const asOf = new Date(`${raw.as_of}T00:00:00Z`).getTime();
  const protocols: Proto[] = raw.protocols.map((p) => ({
    slug: p.slug,
    name: p.name,
    cat: p.category ?? 'Unknown',
    chains: p.chains,
    tvl: p.tvl_usd,
    g7: p.change_7d,
    mcap: p.mcap_usd,
    listedAt: p.listed_at,
    age: p.listed_at === null ? null : (asOf - new Date(`${p.listed_at}T00:00:00Z`).getTime()) / 86400000 / 365.25,
    hasToken: p.gecko_id !== null || p.symbol !== null,
  }));
  return { asOf: raw.as_of, floor: raw.floor_usd, protocols, watchlist: [...raw.watchlist].sort() };
}

// ------------------------------------------------------------------ numerics

const log10 = (x: number): number => Math.log10(x);

/** Ordinary least squares by Gauss-Jordan; X rows are design rows. */
export function ols(X: number[][], y: number[]): number[] {
  const k = X[0]!.length;
  const A: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b: number[] = new Array<number>(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let a = 0; a < k; a++) {
      b[a]! += X[i]![a]! * y[i]!;
      for (let c = 0; c < k; c++) A[a]![c]! += X[i]![a]! * X[i]![c]!;
    }
  }
  for (let a = 1; a < k; a++) A[a]![a]! += 1e-9;
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[piv]![c]!)) piv = r;
    [A[c], A[piv]] = [A[piv]!, A[c]!];
    [b[c], b[piv]] = [b[piv]!, b[c]!];
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = A[r]![c]! / A[c]![c]!;
      for (let j = c; j < k; j++) A[r]![j]! -= f * A[c]![j]!;
      b[r]! -= f * b[c]!;
    }
  }
  return b.map((v, i) => v / A[i]![i]!);
}

/** Median of 10^|log error| over [actual, predicted] log pairs. */
export function medianMiss(pairs: Array<[number, number]>): number {
  const errs = pairs.map(([a, p]) => Math.abs(a - p)).sort((a, b) => a - b);
  return Math.pow(10, errs[Math.floor(errs.length / 2)]!);
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const at = q * (sorted.length - 1);
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

export function sha8Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 8);
}

// ---------------------------------------------------------------- value model

export interface Peer {
  slug: string;
  cat: string;
  x: number; // log10 TVL
  y: number; // log10 market cap
  g7: number;
  age: number;
  listed: string;
}

export interface ValueFit {
  beta: number[]; // [intercept, size slope, hinge slope, g7 slope]
  catFx: Map<string, number>;
  catN: Map<string, number>;
  residQ: { q10: number; q25: number; q75: number; q90: number };
  within3: { loo: number; wf: number };
  tests: { loo: number; wf: number; ten: number; oldNew: number; flatLoo: number; flatWf: number };
  termRows: Array<{ term: string; loo: number; wf: number; ten: number; oldNew: number; kept: string }>;
  nPeers: number;
}

function valueFeatures(p: { x: number; g7: number }): number[] {
  return [1, p.x - 8, Math.max(0, p.x - 9), Math.max(-50, Math.min(50, p.g7)) / 100];
}

function shrunkCatFx(train: Peer[], resid: number[], k: number): Map<string, number> {
  const by = new Map<string, number[]>();
  for (let i = 0; i < train.length; i++) {
    const c = train[i]!.cat;
    if (!by.has(c)) by.set(c, []);
    by.get(c)!.push(resid[i]!);
  }
  const fx = new Map<string, number>();
  for (const [c, rs] of by) {
    const m = rs.reduce((a, b) => a + b, 0) / rs.length;
    fx.set(c, (rs.length / (rs.length + k)) * m);
  }
  return fx;
}

function fitValue(train: Peer[]): { predict: (p: { x: number; g7: number; cat: string }) => number; beta: number[]; catFx: Map<string, number> } {
  const X = train.map((p) => valueFeatures(p));
  const y = train.map((p) => p.y);
  const beta = ols(X, y);
  const base = (p: { x: number; g7: number }): number => valueFeatures(p).reduce((s, v, i) => s + v * beta[i]!, 0);
  const catFx = shrunkCatFx(train, train.map((p) => p.y - base(p)), 64);
  return {
    beta,
    catFx,
    predict: (p) => base(p) + (catFx.get(p.cat) ?? 0),
  };
}

function flatPredict(train: Peer[]): (p: Peer) => number {
  const mults = train.map((p) => Math.pow(10, p.y - p.x)).sort((a, b) => a - b);
  const med = mults[Math.floor(mults.length / 2)]!;
  return (p) => p.x + log10(med);
}

/** Fit the value model on the dated priced peers and test it four ways. */
export function fitValueModel(peers: Peer[]): ValueFit {
  const byDate = [...peers].sort((a, b) => (a.listed < b.listed ? -1 : 1));
  const cut = Math.floor(byDate.length / 2);
  const old = peers.filter((p) => p.listed < '2024-01-01');
  const nw = peers.filter((p) => p.listed >= '2024-01-01');
  const bySlug = [...peers].sort((a, b) => (a.slug < b.slug ? -1 : 1));

  const runTests = (fit: (tr: Peer[]) => (p: Peer) => number): { loo: number; wf: number; ten: number; oldNew: number } => {
    const loo: Array<[number, number]> = [];
    for (let i = 0; i < peers.length; i++) {
      const f = fit(peers.filter((_, j) => j !== i));
      loo.push([peers[i]!.y, f(peers[i]!)]);
    }
    const wf = fit(byDate.slice(0, cut));
    const wfPairs = byDate.slice(cut).map((p): [number, number] => [p.y, wf(p)]);
    const tenPairs: Array<[number, number]> = [];
    for (let f = 0; f < 10; f++) {
      const te = bySlug.filter((_, i) => i % 10 === f);
      const ff = fit(bySlug.filter((_, i) => i % 10 !== f));
      for (const p of te) tenPairs.push([p.y, ff(p)]);
    }
    const on = fit(old);
    const onPairs = nw.map((p): [number, number] => [p.y, on(p)]);
    return { loo: medianMiss(loo), wf: medianMiss(wfPairs), ten: medianMiss(tenPairs), oldNew: medianMiss(onPairs) };
  };

  const full = fitValue(peers);
  const tests = runTests((tr) => fitValue(tr).predict);
  const flat = runTests(flatPredict);
  // LOO residuals of the full fit, for conformal intervals.
  const looResid: number[] = [];
  for (let i = 0; i < peers.length; i++) {
    const f = fitValue(peers.filter((_, j) => j !== i));
    looResid.push(peers[i]!.y - f.predict(peers[i]!));
  }
  const sorted = [...looResid].sort((a, b) => a - b);
  const residQ = { q10: quantile(sorted, 0.1), q25: quantile(sorted, 0.25), q75: quantile(sorted, 0.75), q90: quantile(sorted, 0.9) };
  const within3 = {
    loo: looResid.filter((r) => Math.abs(r) < Math.log10(3)).length / looResid.length,
    wf: byDate.slice(cut).filter((p) => Math.abs(p.y - fitValue(byDate.slice(0, cut)).predict(p)) < Math.log10(3)).length / (byDate.length - cut),
  };

  // Per-term table: each candidate term added to the size-only base, tested.
  const termRows: ValueFit['termRows'] = [];
  const specOf = (terms: string[]) => (tr: Peer[]) => {
    const feat = (p: Peer): number[] => {
      const v = [1, p.x - 8];
      if (terms.includes('hinge')) v.push(Math.max(0, p.x - 9));
      if (terms.includes('size2')) v.push((p.x - 8) * (p.x - 8));
      if (terms.includes('g7')) v.push(Math.max(-50, Math.min(50, p.g7)) / 100);
      if (terms.includes('age')) v.push(Math.log10(0.25 + p.age));
      return v;
    };
    const beta = ols(tr.map(feat), tr.map((p) => p.y));
    const base = (p: Peer): number => feat(p).reduce((s, v, i) => s + v * beta[i]!, 0);
    if (!terms.includes('cat')) return base;
    const fx = shrunkCatFx(tr, tr.map((p) => p.y - base(p)), 64);
    return (p: Peer): number => base(p) + (fx.get(p.cat) ?? 0);
  };
  const baseTests = runTests(specOf([]));
  const pushTerm = (label: string, terms: string[], kept: string): void => {
    const t = runTests(specOf(terms));
    termRows.push({ term: label, loo: t.loo, wf: t.wf, ten: t.ten, oldNew: t.oldNew, kept });
  };
  termRows.push({ term: 'flat median multiple', loo: flat.loo, wf: flat.wf, ten: flat.ten, oldNew: flat.oldNew, kept: 'baseline' });
  termRows.push({ term: 'size curve, log TVL (base)', loo: baseTests.loo, wf: baseTests.wf, ten: baseTests.ten, oldNew: baseTests.oldNew, kept: 'kept' });
  pushTerm('size + hinge above $1B TVL', ['hinge'], 'kept');
  pushTerm('size + category effect, ridge 64', ['cat'], 'kept');
  pushTerm('size + 7-day TVL growth', ['g7'], 'kept');
  pushTerm('size + squared size', ['size2'], 'tested, not kept');
  pushTerm('size + no-token age', ['age'], 'tested, not kept');
  termRows.push({ term: 'final model: size + hinge + category + 7-day growth', loo: tests.loo, wf: tests.wf, ten: tests.ten, oldNew: tests.oldNew, kept: 'kept' });

  const catN = new Map<string, number>();
  for (const p of peers) catN.set(p.cat, (catN.get(p.cat) ?? 0) + 1);
  return {
    beta: full.beta,
    catFx: full.catFx,
    catN,
    residQ,
    within3,
    tests: { ...tests, flatLoo: flat.loo, flatWf: flat.wf },
    termRows,
    nPeers: peers.length,
  };
}

// ----------------------------------------------------------------- odds model

export interface OddsFit {
  L: number;
  k: number;
  brierSurv: number;
  brierSurv10: number;
  brierLogit: number;
  brierLogit10: number;
  baseBrier: number;
  calledRight: number;
  nDated: number;
  termRows: Array<{ term: string; brier: number; brier10: number; kept: string }>;
  ageBands: Array<{ band: string; n: number; rate: number }>;
  catRates: Array<{ cat: string; n: number; rate: number; medianAge: number; oldN: number; oldRate: number }>;
}

const sig = (z: number): number => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

function logitFitRidge(X: number[][], y: number[], lam: number): number[] {
  const k = X[0]!.length;
  let beta = new Array<number>(k).fill(0);
  const s = y.reduce((a, b) => a + b, 0);
  beta[0] = Math.log((s + 0.5) / (y.length - s + 0.5));
  for (let it = 0; it < 80; it++) {
    const p = X.map((row) => sig(row.reduce((s2, v, j) => s2 + v * beta[j]!, 0)));
    const W = p.map((v) => Math.max(v * (1 - v), 1e-6));
    const A: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    const b: number[] = new Array<number>(k).fill(0);
    for (let i = 0; i < X.length; i++) {
      const z = X[i]!.reduce((s2, v, j) => s2 + v * beta[j]!, 0) + (y[i]! - p[i]!) / W[i]!;
      for (let a = 0; a < k; a++) {
        b[a]! += W[i]! * X[i]![a]! * z;
        for (let c = 0; c < k; c++) A[a]![c]! += W[i]! * X[i]![a]! * X[i]![c]!;
      }
    }
    for (let a = 1; a < k; a++) A[a]![a]! += lam;
    for (let c = 0; c < k; c++) {
      let piv = c;
      for (let r = c + 1; r < k; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[piv]![c]!)) piv = r;
      [A[c], A[piv]] = [A[piv]!, A[c]!];
      [b[c], b[piv]] = [b[piv]!, b[c]!];
      for (let r = 0; r < k; r++) {
        if (r === c) continue;
        const f = A[r]![c]! / A[c]![c]!;
        for (let j = c; j < k; j++) A[r]![j]! -= f * A[c]![j]!;
        b[r]! -= f * b[c]!;
      }
    }
    const nb = b.map((v, i) => v / A[i]![i]!);
    const diff = Math.max(...nb.map((v, i) => Math.abs(v - beta[i]!)));
    beta = nb;
    if (diff < 1e-8) break;
  }
  return beta;
}

/** Fit the survival listing curve and the cross-check logistic on dated rows. */
export function fitOddsModel(rows: Array<{ age: number | null; y: number; cat: string; tvl: number; g7: number; chains: number }>): OddsFit {
  const dated = rows.filter((r) => r.age !== null) as Array<{ age: number; y: number; cat: string; tvl: number; g7: number; chains: number }>;
  // Maximum-likelihood grid search for L (eventual rate) and k (hazard per year).
  let best = { L: 0.85, k: 0.55, ll: -Infinity };
  for (let L = 0.7; L <= 0.96; L += 0.01) {
    for (let k = 0.1; k <= 2.5; k += 0.05) {
      let ll = 0;
      for (const r of dated) {
        const p = L * (1 - Math.exp(-k * r.age));
        ll += r.y === 1 ? Math.log(Math.max(p, 1e-9)) : Math.log(Math.max(1 - p, 1e-9));
      }
      if (ll > best.ll) best = { L, k, ll };
    }
  }
  const pBy = (a: number): number => best.L * (1 - Math.exp(-best.k * a));
  const brier = (pairs: Array<[number, number]>): number => pairs.reduce((s, [a, p]) => s + (p - a) ** 2, 0) / pairs.length;
  const brierSurv = brier(dated.map((r): [number, number] => [r.y, pBy(r.age)]));
  const bySlug = [...dated].sort((a, b) => `${a.cat}/${a.tvl}` < `${b.cat}/${b.tvl}` ? -1 : 1);
  const surv10: Array<[number, number]> = [];
  for (let f = 0; f < 10; f++) {
    const te = bySlug.filter((_, i) => i % 10 === f);
    const tr = bySlug.filter((_, i) => i % 10 !== f);
    let b2 = { L: 0.85, k: 0.55, ll: -Infinity };
    for (let L = 0.7; L <= 0.96; L += 0.02) {
      for (let k = 0.1; k <= 2.5; k += 0.1) {
        let ll = 0;
        for (const r of tr) {
          const p = L * (1 - Math.exp(-k * r.age));
          ll += r.y === 1 ? Math.log(Math.max(p, 1e-9)) : Math.log(Math.max(1 - p, 1e-9));
        }
        if (ll > b2.ll) b2 = { L, k, ll };
      }
    }
    for (const r of te) surv10.push([r.y, b2.L * (1 - Math.exp(-b2.k * r.age))]);
  }
  const brierSurv10 = brier(surv10);
  // Cross-check logistic: age, size, 7d growth + ridge-shrunk category dummies.
  const cats = [...new Set(dated.map((r) => r.cat))].sort();
  const design = (r: { age: number; tvl: number; g7: number; cat: string }): number[] => {
    const v = [1, Math.log10(0.25 + r.age), log10(r.tvl) - 8, Math.max(-50, Math.min(50, r.g7)) / 100];
    for (const c of cats) v.push(r.cat === c ? 1 : 0);
    return v;
  };
  const X = dated.map(design);
  const y = dated.map((r) => r.y);
  const beta = logitFitRidge(X, y, 2);
  const pLog = (r: { age: number; tvl: number; g7: number; cat: string }): number => sig(design(r).reduce((s, v, j) => s + v * beta[j]!, 0));
  const brierLogit = brier(dated.map((r): [number, number] => [r.y, pLog(r)]));
  const logit10: Array<[number, number]> = [];
  const slugOrder = [...dated].sort((a, b) => (a.cat < b.cat ? -1 : a.cat > b.cat ? 1 : a.tvl - b.tvl));
  for (let f = 0; f < 10; f++) {
    const te = slugOrder.filter((_, i) => i % 10 === f);
    const tr = slugOrder.filter((_, i) => i % 10 !== f);
    const b = logitFitRidge(tr.map(design), tr.map((r) => r.y), 2);
    for (const r of te) logit10.push([r.y, sig(design(r).reduce((s, v, j) => s + v * b[j]!, 0))]);
  }
  const brierLogit10 = brier(logit10);
  const rate = y.reduce((a, b) => a + b, 0) / y.length;
  const baseBrier = rate * (1 - rate);
  const calledRight = dated.filter((r) => (pLog(r) > 0.5 ? 1 : 0) === r.y).length / dated.length;

  // Per-term Brier table: each term added to the age-only base.
  const specDesign = (r: { age: number; tvl: number; g7: number; cat: string }, spec: string[]): number[] => {
    const v = [1];
    for (const t of spec) {
      if (t === 'age') v.push(Math.log10(0.25 + r.age));
      else if (t === 'size') v.push(log10(r.tvl) - 8);
      else if (t === 'g7') v.push(Math.max(-50, Math.min(50, r.g7)) / 100);
    }
    if (spec.includes('cat')) for (const c of cats) v.push(r.cat === c ? 1 : 0);
    return v;
  };
  const specBrier = (spec: string[]): { brier: number; brier10: number } => {
    const b = logitFitRidge(dated.map((r) => specDesign(r, spec)), y, spec.includes('cat') ? 2 : 1e-3);
    const inS = brier(dated.map((r): [number, number] => [r.y, sig(specDesign(r, spec).reduce((s, v, j) => s + v * b[j]!, 0))]));
    const folds: Array<[number, number]> = [];
    for (let f = 0; f < 10; f++) {
      const te = slugOrder.filter((_, i) => i % 10 === f);
      const tr = slugOrder.filter((_, i) => i % 10 !== f);
      const bf = logitFitRidge(tr.map((r) => specDesign(r, spec)), tr.map((r) => r.y), spec.includes('cat') ? 2 : 1e-3);
      for (const r of te) folds.push([r.y, sig(specDesign(r, spec).reduce((s, v, j) => s + v * bf[j]!, 0))]);
    }
    return { brier: inS, brier10: brier(folds) };
  };
  const baseRow = { term: 'base rate of peers', brier: baseBrier, brier10: baseBrier, kept: 'baseline' };
  const ageRow = specBrier(['age']);
  const sizeRow = specBrier(['age', 'size']);
  const g7Row = specBrier(['age', 'size', 'g7']);
  const catRow = specBrier(['age', 'size', 'g7', 'cat']);
  const termRows = [
    baseRow,
    { term: 'age, years listed', brier: ageRow.brier, brier10: ageRow.brier10, kept: 'kept' },
    { term: 'size curve, log TVL', brier: sizeRow.brier, brier10: sizeRow.brier10, kept: 'tested, not kept' },
    { term: '7-day TVL growth', brier: g7Row.brier, brier10: g7Row.brier10, kept: 'tested, not kept' },
    { term: 'category effect, ridge 2', brier: catRow.brier, brier10: catRow.brier10, kept: 'kept' },
  ];

  const bands: Array<[string, number, number]> = [['under 6 months', 0, 0.5], ['6-12 months', 0.5, 1], ['1-1.5 years', 1, 1.5], ['1.5-2 years', 1.5, 2], ['2-3 years', 2, 3], ['3 years and over', 3, 99]];
  const ageBands = bands.map(([band, lo, hi]) => {
    const s = dated.filter((r) => r.age >= lo && r.age < hi);
    return { band, n: s.length, rate: s.length === 0 ? 0 : s.filter((r) => r.y === 1).length / s.length };
  });
  const catRates: OddsFit['catRates'] = [];
  const byCat = new Map<string, typeof dated>();
  for (const r of dated) {
    if (!byCat.has(r.cat)) byCat.set(r.cat, []);
    byCat.get(r.cat)!.push(r);
  }
  for (const [c, rs] of [...byCat.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (rs.length < 10) continue;
    const ages = rs.map((r) => r.age).sort((a, b) => a - b);
    const old = rs.filter((r) => r.age >= 2);
    catRates.push({
      cat: c,
      n: rs.length,
      rate: rs.filter((r) => r.y === 1).length / rs.length,
      medianAge: ages[Math.floor(ages.length / 2)]!,
      oldN: old.length,
      oldRate: old.length === 0 ? 0 : old.filter((r) => r.y === 1).length / old.length,
    });
  }
  return {
    L: best.L,
    k: best.k,
    brierSurv,
    brierSurv10,
    brierLogit,
    brierLogit10,
    baseBrier,
    calledRight,
    nDated: dated.length,
    termRows,
    ageBands,
    catRates,
  };
}

// ------------------------------------------------------------------ the board

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  rankLo: number;
  rankHi: number;
  tier: 'Watchlist' | 'Early' | 'Off-list';
  category: string;
  chains: string[];
  tvl: number;
  g7: number | null;
  age: number | null;
  odds: number;
  oddsByAge: number;
  ifLaunches: number;
  implied: number;
  p25: number;
  p75: number;
  p10: number;
  p90: number;
  verdict: 'FARM' | 'MARGINAL' | 'SKIP';
  deposit: number;
  minDeposit: number | null;
  drop: number;
  fees: number;
  net: number;
  netHour: number;
  tbill: number;
  hours: number;
  exitTvl: number;
  dropIfLaunches: number;
  feesCoverShare: number;
  feesCoverOdds: number;
  farmSteps: string[];
  warnings: string[];
}

export interface Radar {
  model: string;
  asOf: string;
  nProtocols: number;
  nWatchlist: number;
  nRows: number;
  nFarm: number;
  nMarginal: number;
  nSkip: number;
  totalImplied: number;
  value: ValueFit;
  odds: OddsFit;
  coverage: { p2575: number; p1090: number };
  accounting: {
    ranked: { watchlist: number; early: number; offList: number };
    live: { priced: number; noCap: number };
    out: { bridge: number; liquidStaking: number; exchange: number; versioned: number };
  };
  rows: BoardRow[];
  peers: Array<{ slug: string; name: string; cat: string; tvl: number; mcap: number; ratio: number; heldOut: number }>;
  live: Array<{ slug: string; name: string; cat: string; tvl: number; mcap: number | null; listedAt: string | null }>;
  setAside: Array<{ slug: string; name: string; cat: string; tvl: number; group: string }>;
  mainSha8: string;
}

const DEPOSIT_GRID = [500, 1000, 2000, 3000, 5000, 7500, 10000, 15000, 20000, 30000, 50000, 75000, 100000];
const DROP_SHARE = 0.07;
const TBILL_RATE = 0.04;
const HORIZON_WEEKS = 12;
const FARM_NET_HOUR = 25;

export function gasPerTx(chain: string): number {
  if (chain === 'Ethereum') return 2.0;
  if (chain === 'Solana') return 0.01;
  return 0.05;
}

export function money(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function coreAction(cat: string, name: string, chain: string, dep: string): string {
  switch (cat) {
    case 'Lending':
      return `Deposit ${dep} into ${name}'s lending market on ${chain} and hold the receipt tokens`;
    case 'Dexs':
      return `Add ${dep} of liquidity to ${name}'s main pool on ${chain} and hold the LP position`;
    case 'Yield':
    case 'Yield Aggregator':
      return `Deposit ${dep} into ${name}'s main vault on ${chain} and hold the vault shares`;
    case 'RWA':
      return `Deposit ${dep} into ${name}'s tokenised-asset vault on ${chain} and hold the receipt`;
    case 'Risk Curators':
    case 'Onchain Capital Allocator':
      return `Deposit ${dep} into a ${name} vault on ${chain} and hold the vault shares`;
    case 'CDP':
      return `Open a ${dep} collateral position on ${name} on ${chain} and keep it over-collateralised`;
    case 'Derivatives':
      return `Deposit ${dep} of margin on ${name} on ${chain} and hold the position`;
    default:
      return `Deposit ${dep} into ${name} on ${chain} and hold the position it gives back`;
  }
}

function riskNote(cat: string): string {
  switch (cat) {
    case 'Lending':
      return 'check who borrows, at what collateral ratio, and what happens in a liquidation cascade';
    case 'Dexs':
      return 'check the pool\'s depth and whether the pair\'s other side can be withdrawn at will';
    case 'Yield':
    case 'Yield Aggregator':
      return 'check whether the yield is mostly paid in unlisted points tokens';
    case 'RWA':
      return 'check who holds the underlying assets and how redemption works';
    case 'Risk Curators':
    case 'Onchain Capital Allocator':
      return 'check how many strategies the vault stacks and whether one takes most of it';
    case 'CDP':
      return 'check the liquidation threshold and the stability fee before minting anything';
    default:
      return 'check the fee schedule and who else\'s contracts sit underneath it';
  }
}

/** The 10-step farm plan, named phases, sized to this row's economics. */
export function farmPlan(row: {
  name: string;
  cat: string;
  chains: string[];
  tvl: number;
  age: number | null;
  deposit: number;
  exitTvl: number;
  gas: number;
}): string[] {
  const dep = money(row.deposit);
  const chain = row.chains[0] ?? 'Ethereum';
  const chain2 = row.chains[1] ?? chain;
  const gas = row.gas.toFixed(2);
  const tvl = money(row.tvl);
  const exit = money(row.exitTvl);
  const pct = ((row.deposit / row.tvl) * 100).toFixed(3);
  const ageText = row.age === null ? 'an unrecorded age' : `${row.age.toFixed(1)} year${row.age === 1 ? '' : 's'}`;
  const steps = [
    `SETUP - Open a fresh wallet used only for this farm, on ${chain}, and fund it with ${dep} of USDC plus gas. Keep the seed phrase offline and never paste it anywhere. Cost: about $${gas} of gas to fund it. Time: 10 minutes.`,
    `VERIFY - Reach ${row.name} from its DefiLlama page and match the app's contract addresses against its docs before approving anything. Never sign an approval from a link sent in a DM. Cost: free. Time: 5 minutes.`,
    `FUND - Move ${dep} of USDC to ${chain} from an exchange that supports it, or bridge it from Ethereum with a large bridge that lists ${chain}. Cost: about $1.00 (one exchange withdrawal). Time: 10 minutes; wait 2-20 minutes to arrive.`,
    `RISK - Read ${row.name}'s strategy and fee page first: ${riskNote(row.cat)}. A vault that stacks other protocols can fail through any of them. Cost: free (reading only). Time: 10 minutes.`,
    `CORE - ${coreAction(row.cat, row.name, chain, dep)}. Start with a $100 test, then size up to the full ${dep} (the plan size, ${pct}% of its ${tvl} TVL). Cost: $${(3 * row.gas).toFixed(2)} (3 transactions at about $${gas} on ${chain}). Time: 15 minutes.`,
    `DEEPEN - Hold the receipt token, or post it where ${row.name} lists a points boost (a lending market or a liquidity pool), but never loop it more than once. A second deployment on ${chain2} lets the same wallet show activity on more than one chain. Cost: $${(2 * row.gas).toFixed(2)} (2 transactions at about $${gas} on ${chain}). Time: 10 minutes.`,
    `CADENCE - ${row.name} has run ${ageText} with no token recorded. Touch the position once a week (a top-up, a claim, a vote) so the wallet shows steady use rather than one deposit. Cost: $${gas} a week (1 transaction a week at about $${gas} on ${chain}). Time: 5 minutes a week for 12 weeks.`,
    `WATCH - Exit rule, checked weekly: withdraw if TVL prints below ${exit}, which is 17% down from today's ${tvl}; also if withdrawals pause or the team says a snapshot has already been taken. Cost: free. Time: 5 minutes a week for 12 weeks.`,
    `RECORD - Keep a ledger from the first transaction: date, transaction hash, asset, amount and dollar value of the ${dep} deposit and of every top-up, claim and withdrawal. A drop is taxable income in many places at its value on the day it arrives. Cost: free. Time: 5 minutes.`,
    `EXIT - Take the position down by half once the modelled drop would cover the fees twice over, and hold the rest to the 30-day mark. If a drop lands, claim it from the official app only, never from a link. Cost: about $${gas} of gas to unwind half. Time: 10 minutes.`,
  ];
  return steps;
}

export interface BuildInput {
  snapshot: Snapshot;
  value: ValueFit;
  odds: OddsFit;
  mainSha8: string;
}

/** Score every clean pre-token protocol and rank the board by implied value. */
export function buildRadar(input: BuildInput): Radar {
  const { snapshot, value, odds } = input;
  const wl = new Set(snapshot.watchlist);

  const peers: Peer[] = snapshot.protocols
    .filter((p) => p.hasToken && p.mcap !== null && p.mcap > 0 && p.tvl > 0 && p.listedAt !== null)
    .map((p) => ({ slug: p.slug, cat: p.cat, x: log10(p.tvl), y: log10(p.mcap!), g7: p.g7 ?? 0, age: p.age!, listed: p.listedAt! }));

  // Conformal intervals from the LOO residuals.
  const looResid: number[] = [];
  for (let i = 0; i < peers.length; i++) {
    const f = fitValue(peers.filter((_, j) => j !== i));
    looResid.push(peers[i]!.y - f.predict(peers[i]!));
  }
  const srt = [...looResid].sort((a, b) => a - b);
  const q = value.residQ;
  const in2575 = looResid.filter((r) => r >= q.q25 && r <= q.q75).length / looResid.length;
  const in1090 = looResid.filter((r) => r >= q.q10 && r <= q.q90).length / looResid.length;

  // Rank ranges across leave-one-out refits: refit the value model 95 times,
  // each time leaving one priced peer out, and re-rank. A wide range means the
  // row's rank moves when a single priced peer leaves the sample; the middle
  // of the board is dense, so mid-field rows move more than the top.
  const rankLo = new Map<string, number>();
  const rankHi = new Map<string, number>();
  const rankedProtos = snapshot.protocols.filter((p) => !p.hasToken && exclusionGroup(p) === null);
  const predictWith = (fit: ReturnType<typeof fitValue>) => (p: Proto): number => {
    const base = fit.beta[0]! + fit.beta[1]! * (log10(p.tvl) - 8) + fit.beta[2]! * Math.max(0, log10(p.tvl) - 9) + fit.beta[3]! * (Math.max(-50, Math.min(50, p.g7 ?? 0)) / 100);
    return base + (fit.catFx.get(p.cat) ?? 0);
  };
  const oddsOf = (p: Proto): { byAge: number; cond: number } => {
    const a = p.age ?? 1.5;
    const byAge = odds.L * (1 - Math.exp(-odds.k * a));
    const cond = Math.max(0.02, Math.min(0.98, (odds.L - byAge) / (1 - byAge)));
    return { byAge, cond };
  };
  const scoreAll = (fit: ReturnType<typeof fitValue>): Array<{ slug: string; implied: number }> =>
    rankedProtos
      .map((p) => {
        const ifLaunches = Math.pow(10, predictWith(fit)(p));
        return { slug: p.slug, implied: Math.max(1, Math.round(ifLaunches * oddsOf(p).cond)) };
      })
      .sort((a, b) => b.implied - a.implied);
  for (let i = 0; i < peers.length; i++) {
    const fit = fitValue(peers.filter((_, j) => j !== i));
    const order = scoreAll(fit);
    order.forEach((r, j) => {
      const rank = j + 1;
      rankLo.set(r.slug, Math.min(rankLo.get(r.slug) ?? rank, rank));
      rankHi.set(r.slug, Math.max(rankHi.get(r.slug) ?? rank, rank));
    });
  }

  const fullFit = fitValue(peers);
  const predict = predictWith(fullFit);
  const rows: BoardRow[] = rankedProtos
    .map((p) => {
      const ifLaunches = Math.max(1, Math.round(Math.pow(10, predict(p))));
      const { byAge, cond } = oddsOf(p);
      const implied = Math.max(1, Math.round(ifLaunches * cond));
      const p25 = Math.max(1, Math.round(ifLaunches * Math.pow(10, q.q25) * cond));
      const p75 = Math.max(1, Math.round(ifLaunches * Math.pow(10, q.q75) * cond));
      const p10 = Math.max(1, Math.round(ifLaunches * Math.pow(10, q.q10) * cond));
      const p90 = Math.max(1, Math.round(ifLaunches * Math.pow(10, q.q90) * cond));
      const gas = gasPerTx(p.chains[0] ?? 'Ethereum');
      const fees = 6 * gas;
      const hours = (175 + 10 * Math.min(Math.max(p.chains.length - 1, 0), 3)) / 60;
      const dropAt = (d: number): number => (DROP_SHARE * implied * d) / (p.tvl + d);
      const tbillAt = (d: number): number => (d * TBILL_RATE * HORIZON_WEEKS) / 52;
      const isFarm = (d: number): boolean => {
        const net = dropAt(d) - fees;
        return net > tbillAt(d) && net / hours >= FARM_NET_HOUR;
      };
      const minDeposit = DEPOSIT_GRID.find((d) => isFarm(d)) ?? null;
      const deposit = minDeposit ?? 10000;
      const drop = dropAt(deposit);
      const net = drop - fees;
      const tbill = tbillAt(deposit);
      const verdict: BoardRow['verdict'] = isFarm(deposit) ? 'FARM' : net > 0 ? 'MARGINAL' : 'SKIP';
      const warnings: string[] = [];
      if ((p.g7 ?? 0) < -5) warnings.push(`TVL down ${Math.abs(p.g7 ?? 0).toFixed(1)}% in 7 days`);
      if (cond < 0.6) warnings.push(`token odds under 60% (${Math.round(cond * 100)}%)`);
      return {
        slug: p.slug,
        name: p.name,
        rank: 0,
        rankLo: rankLo.get(p.slug) ?? 0,
        rankHi: rankHi.get(p.slug) ?? 0,
        tier: wl.has(p.slug) ? 'Watchlist' : p.tvl >= snapshot.floor ? 'Off-list' : 'Early',
        category: p.cat,
        chains: p.chains,
        tvl: p.tvl,
        g7: p.g7,
        age: p.age,
        odds: cond,
        oddsByAge: byAge,
        ifLaunches,
        implied,
        p25,
        p75,
        p10,
        p90,
        verdict,
        deposit,
        minDeposit,
        drop,
        fees,
        net,
        netHour: net / hours,
        tbill,
        hours,
        exitTvl: Math.round(p.tvl * 0.83),
        dropIfLaunches: drop / Math.max(cond, 0.02),
        feesCoverShare: (fees * (p.tvl + deposit)) / Math.max(implied * deposit, 1),
        feesCoverOdds: (fees * (p.tvl + deposit)) / Math.max(DROP_SHARE * ifLaunches * deposit, 1),
        farmSteps: farmPlan({ name: p.name, cat: p.cat, chains: p.chains, tvl: p.tvl, age: p.age, deposit, exitTvl: Math.round(p.tvl * 0.83), gas }),
        warnings,
      };
    })
    .sort((a, b) => b.implied - a.implied);
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });

  const totalImplied = rows.reduce((s, r) => s + r.implied, 0);
  const priced = snapshot.protocols.filter((p) => p.hasToken && p.mcap !== null && p.mcap > 0).length;
  const outGroups = { bridge: 0, liquidStaking: 0, exchange: 0, versioned: 0 };
  for (const p of snapshot.protocols) {
    if (p.hasToken) continue;
    const g = exclusionGroup(p);
    if (g === 'bridge') outGroups.bridge++;
    else if (g === 'liquid-staking') outGroups.liquidStaking++;
    else if (g === 'exchange') outGroups.exchange++;
    else if (g === 'versioned-or-wrapped') outGroups.versioned++;
  }
  const peerRows = peers
    .map((p) => {
      const proto = snapshot.protocols.find((x) => x.slug === p.slug)!;
      const held = fitValue(peers.filter((q) => q.slug !== p.slug)).predict(p);
      return { slug: p.slug, name: proto.name, cat: p.cat, tvl: proto.tvl, mcap: proto.mcap!, ratio: proto.mcap! / proto.tvl, heldOut: Math.pow(10, held) / proto.tvl };
    })
    .sort((a, b) => b.tvl - a.tvl);
  const live = snapshot.protocols
    .filter((p) => p.hasToken)
    .map((p) => ({ slug: p.slug, name: p.name, cat: p.cat, tvl: p.tvl, mcap: p.mcap, listedAt: p.listedAt }))
    .sort((a, b) => b.tvl - a.tvl);
  const setAside = snapshot.protocols
    .filter((p) => !p.hasToken && exclusionGroup(p) !== null)
    .map((p) => ({ slug: p.slug, name: p.name, cat: p.cat, tvl: p.tvl, group: exclusionGroup(p)! }))
    .sort((a, b) => b.tvl - a.tvl);
  return {
    model: MODEL_VERSION,
    asOf: snapshot.as_of,
    nProtocols: snapshot.protocols.length,
    nWatchlist: snapshot.watchlist.length,
    nRows: rows.length,
    nFarm: rows.filter((r) => r.verdict === 'FARM').length,
    nMarginal: rows.filter((r) => r.verdict === 'MARGINAL').length,
    nSkip: rows.filter((r) => r.verdict === 'SKIP').length,
    totalImplied,
    value,
    odds,
    coverage: { p2575: in2575, p1090: in1090 },
    accounting: {
      ranked: {
        watchlist: rows.filter((r) => r.tier === 'Watchlist').length,
        early: rows.filter((r) => r.tier === 'Early').length,
        offList: rows.filter((r) => r.tier === 'Off-list').length,
      },
      live: { priced, noCap: snapshot.protocols.filter((p) => p.hasToken).length - priced },
      out: outGroups,
    },
    rows,
    peers: peerRows,
    mainSha8: input.mainSha8,
  };
}

/** The gate's own shape check, run before writing anything. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board holds ${board.length} rows, the gate wants 100 to 4000`;
  const seen = new Set<string>();
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  for (let i = 0; i < board.length; i++) {
    const r = board[i]!;
    if (!slugs.has(r.slug)) return `row ${i + 1} names ${r.slug}, not in the snapshot`;
    if (seen.has(r.slug)) return `row ${i + 1} repeats ${r.slug}`;
    seen.add(r.slug);
    if (r.name.trim() === '') return `row ${i + 1} has an empty name`;
    if (r.rank !== i + 1) return `row ${i + 1} is ranked ${r.rank}`;
    if (!Number.isInteger(r.implied) || r.implied <= 0) return `row ${i + 1} has a bad implied value`;
    if (i > 0 && board[i - 1]!.implied < r.implied) return `row ${i + 1} breaks the ranking order`;
    if (r.farmSteps.length < 3 || r.farmSteps.length > 12) return `row ${i + 1} holds ${r.farmSteps.length} farm steps`;
    for (const s of r.farmSteps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `row ${i + 1} holds a farm step of ${t.length} characters`;
    }
  }
  for (const s of snapshot.watchlist) {
    if (!seen.has(s)) return `the watchlist protocol ${s} is missing from the board`;
  }
  return null;
}

/** The dashboard's data file: the whole radar as one JS assignment. */
export function dataScript(radar: Radar): string {
  const slim = {
    model: radar.model,
    asOf: radar.asOf,
    nProtocols: radar.nProtocols,
    nWatchlist: radar.nWatchlist,
    nRows: radar.nRows,
    nFarm: radar.nFarm,
    nMarginal: radar.nMarginal,
    nSkip: radar.nSkip,
    totalImplied: radar.totalImplied,
    mainSha8: radar.mainSha8,
    value: {
      beta: radar.value.beta,
      catFx: [...radar.value.catFx.entries()],
      catN: [...radar.value.catN.entries()],
      residQ: radar.value.residQ,
      within3: radar.value.within3,
      tests: radar.value.tests,
      termRows: radar.value.termRows,
      nPeers: radar.value.nPeers,
    },
    odds: {
      L: radar.odds.L,
      k: radar.odds.k,
      brierSurv: radar.odds.brierSurv,
      brierSurv10: radar.odds.brierSurv10,
      brierLogit: radar.odds.brierLogit,
      brierLogit10: radar.odds.brierLogit10,
      baseBrier: radar.odds.baseBrier,
      calledRight: radar.odds.calledRight,
      nDated: radar.odds.nDated,
      termRows: radar.odds.termRows,
      ageBands: radar.odds.ageBands,
      catRates: radar.odds.catRates,
    },
    coverage: radar.coverage,
    accounting: radar.accounting,
    peers: radar.peers,
    live: radar.live,
    setAside: radar.setAside,
    rows: radar.rows,
  };
  return `window.RADAR = ${JSON.stringify(slim)};\n`;
}
