# Token Radar

The best token launch radar for the make.fun `token-radar-01` bounty: it reads
the sealed DefiLlama snapshot, ranks every clean pre-token protocol by what
its launch would be worth, and shows how to farm each one.

## What it does

`main.ts` (Node 22, standard library only) reads `input/snapshot.json`,
fits the value and odds models fresh, writes the ranked board to
`output/board.json`, the dashboard's data to `output/data.js`, and the
dossier to `output/dossier.json` with the vendored make.fun library.

## The model (radar-4)

**Value.** `log10(market cap)` is fitted on the 95 priced peers that carry a
listing date: a size curve in log TVL, a hinge that flattens the slope above
$1B of TVL, the clipped 7-day TVL change, and a category effect shrunk with
64 pseudo-observations. A term stays only when it cuts the median held-out
miss in all four tests.

| Test | Miss |
| --- | --- |
| Leave-one-out | x2.56 |
| Walk-forward (earlier listings price later ones) | x2.48 |
| Ten-fold | x2.85 |
| Older-to-newer (before 2024 prices after) | x2.60 |
| Flat median multiple, leave-one-out | x4.89 |

**Token odds (survival).** A protocol that has run `a` years with no token
lists one eventually with probability `(L - P(a)) / (1 - P(a))`, where
`P(a) = L (1 - exp(-k a))` is the fitted cumulative listing curve
(L = 0.85 eventual rate, k = 0.55 a year, maximum likelihood on the 645
dated protocols). Size does not move the rate once age is known, and the
category rates are confounded by youth (Risk Curators: median age 0.5y, one
member aged 2y+ and it has a token), so the board uses the pooled hazard and
says so. A richer logistic (age, size, category) scores Brier 0.191
in-sample / 0.206 ten-fold; the survival curve alone scores 0.224.

**Implied value.** `TVL x fitted multiple x token odds`. Ranges are the
leave-one-out residual quartiles, so P25-P75 holds about 50% of real caps
and P10-P90 about 80%.

**Farm verdicts.** A row farms when the modelled drop, net of gas, beats
both a 4% T-bill on the same deposit and $25 an hour of hands-on work. The
plan is sized to the smallest deposit that turns the row FARM. Drop is 7%
of implied value times the deposit's share of TVL.

## The board

198 rows: the 40-protocol watchlist, 138 early protocols below the $50M
floor, and 20 above the floor the house list leaves out. The 416 protocols
that already record a token and the 144 the house rules leave out are shown
in their own views, with the reason each one is set aside. Every row
carries a 10-step farm plan with costs and times.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
node /path/to/kit/cli/makefun.mjs check --kit /path/to/kit --repo .
```

The program is deterministic: two runs from different working directories
write byte-identical output. Open `out/dashboard/index.html` in a browser
for the three screenshots: the board, a protocol's detail view, and a
filtered view.

## License

MIT. See `LICENSE`.
