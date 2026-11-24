# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/anissa1881/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/anissa1881/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar ranks the pre-token protocols of a sealed DefiLlama snapshot by what their token
would be worth if the record stayed as it is, and shows a reader how to farm each one. The
model is fitted, never asserted: a category's median market-cap-to-TVL among protocols whose
token already trades (winsorized, shrunk toward the global median, bent by a size curve the
data fits), times token odds read from how often peers of the same age and family record a
token. Every term earns its place by lowering the held-out miss in both out-of-sample tests
(leave-one-out and walk-forward); the ranges are 200 bootstrap refits. No protocol name is
ever special-cased. Wrapped, staked and bridged products are set aside with their reasons
instead of being ranked as launch candidates, and protocols whose token already trades are
shown apart at the market's own value. Each row carries a farm verdict in dollars — a
modelled drop minus the plan's own gas, against a T-bill — and a nine-step farm plan from its
own category's playbook.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path to snapshot.json>
```

The program writes `out/board.json` (197 rows: the 40-protocol watchlist plus the 138
rankable pre-token protocols below the floor and 19 above it that the list leaves out),
`out/data.js`, `out/dashboard/`, `out/screenshots/` and `out/dossier.json`. Open
`out/dashboard/index.html` in a browser to use the dashboard: search, filter by category,
chain or verdict, sort every column, open any row for its model breakdown, farm verdict and
farm plan, and switch between the pre-token board, the live-token view and the set-aside
view. CSV and JSON export are on the board.

---

<sub>Entered on [make.fun](https://make.fun/?ref=anissa1881&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
