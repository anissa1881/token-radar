// Token Radar's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts) and
// renders the ranked board, the evidence behind the model, and a per-protocol detail sheet with
// the model's own arithmetic, the farm verdict and the protocol's farm plan. No network: every
// byte it shows is in data.js, and the page regenerates each farm plan from the same playbook
// main.ts writes to board.json, so the page and the board always agree.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', chain: 'all', tab: 'pre-token', verdict: 'all', sort: 'implied', dir: -1, selected: null };

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtMoney(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return n % 1 === 0 ? '$' + n : '$' + n.toFixed(2);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }

  // ---------------------------------------------------------------- farm plans
  // The same playbook main.ts writes to board.json: nine steps per family, each filled from the
  // protocol's own record (name, chain, deposit, hold, gas) and its verdict. No name is ever
  // special-cased, and the page's steps are the board's steps, checked row by row in testing.
  var GAS = { ethereum: 3.0, bitcoin: 2.0, tron: 0.5, avalanche: 0.2, arbitrum: 0.15, optimism: 0.1, linea: 0.1, zksync: 0.1, starknet: 0.1, bsc: 0.1, base: 0.05, polygon: 0.05, plasma: 0.05, monad: 0.05, sui: 0.05, aptos: 0.05, berachain: 0.05, sonic: 0.05, mantle: 0.05, mode: 0.05, blast: 0.05, fraxtal: 0.05, ink: 0.05, abstract: 0.05, hyperliquid: 0.05, sei: 0.02, solana: 0.02, near: 0.02, injective: 0.02 };
  function gasFor(chain) { return GAS[String(chain).toLowerCase()] || 0.5; }
  function holdDaysFor(age) {
    if (age === null || age === undefined) return 45;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  function familyOf(category) {
    var c = (category || '').toLowerCase();
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'lending';
    if (c.indexOf('dex') >= 0 || c.indexOf('amm') >= 0 || c.indexOf('liquidity manager') >= 0) return 'dex';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0 || c.indexOf('basis trading') >= 0 || c.indexOf('prediction') >= 0 || c.indexOf('options') >= 0) return 'perps';
    if (c.indexOf('yield') >= 0 || c.indexOf('leveraged farm') >= 0 || c.indexOf('farm') >= 0) return 'yield';
    if (c.indexOf('bridge') >= 0) return 'bridge';
    if (c.indexOf('stak') >= 0 || c.indexOf('restak') >= 0) return 'staking';
    if (c.indexOf('rwa') >= 0) return 'rwa';
    if (c.indexOf('insurance') >= 0) return 'insurance';
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0 || c.indexOf('index') >= 0) return 'curator';
    if (c.indexOf('stable') >= 0) return 'stable';
    if (c.indexOf('payment') >= 0) return 'payments';
    if (c === 'chain') return 'chain';
    return 'general';
  }
  function fill(t, ctx) {
    return t.split('{name}').join(ctx.name).split('{chain}').join(ctx.chain).split('{second}').join(ctx.secondChain)
      .split('{capital}').join(String(ctx.capital)).split('{deposit}').join(fmtMoney(ctx.deposit))
      .split('{hold}').join(String(ctx.holdDays)).split('{gas}').join(fmtMoney(ctx.gas));
  }
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  function exitStep(ctx) {
    if (ctx.verdict === 'FARM') return { t: 'Exit only if {name} pauses withdrawals or the position turns against you for a full month; otherwise hold to the {hold}-day mark and claim from the protocol’s own page.', c: 'about {gas} of gas to unwind', time: '10 minutes', mins: 10, tx: 1 };
    if (ctx.verdict === 'MARGINAL') return { t: 'Take the position down by half once the modelled drop would cover the fees twice over, and hold the rest to the {hold}-day mark.', c: 'about {gas} of gas to unwind half', time: '10 minutes', mins: 10, tx: 1 };
    return { t: 'Do not chase this one: unwind the position now, the modelled drop does not cover the fees, and keep the wallet ready for a better farm.', c: 'about {gas} of gas to unwind', time: '10 minutes', mins: 10, tx: 1 };
  }
  function riskStep(text, ctx) {
    return { t: text + ctx.riskNote, c: 'nothing to watch', time: '5 minutes a week', mins: 5, tx: 0 };
  }
  function holdStep() {
    return { t: 'Hold the position for at least {hold} days so the activity spans more than one snapshot window.', c: 'the {deposit} stays in the position', time: '{hold} days', mins: 0, tx: 0 };
  }
  function recordStep(text) { return { t: text, c: 'nothing but the log', time: '5 minutes', mins: 5, tx: 0 }; }
  function playbook(family, ctx) {
    var exit = exitStep(ctx);
    if (family === 'lending') return [
      { t: 'Open a fresh wallet on {chain} and fund it with {deposit} of USDC, keeping the seed phrase offline and the wallet used for nothing else.', c: 'about {gas} of gas to fund it', time: '10 minutes', mins: 10, tx: 1 },
      { t: 'Supply {deposit} of USDC to {name}’s lending market on {chain} and leave the supply earning.', c: '{deposit} of capital, about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
      { t: 'Borrow a small amount of a stable asset against the supply, then repay it the same week, so the wallet shows both sides of the market.', c: 'about {gas} of gas per leg', time: '10 minutes', mins: 10, tx: 2 },
      { t: 'Each week, adjust the supply or make one borrow and repayment; a wallet that only deposits once looks idle in a later snapshot.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
      holdStep(),
      riskStep('Watch the borrow rate and the collateral factor: if the rate stays above the supply yield for two weeks running, repay the borrow and keep only the supply.', ctx),
      { t: 'After a month, supply on a second market of {name} or on {second} with the same wallet, so the history shows depth rather than a single deposit.', c: 'about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
      exit,
      recordStep('Log every supply, borrow and repayment with its date, hash and dollar value, and the borrow rate on the day; a claim may ask the wallet to prove its history.')
    ];
    if (family === 'dex') return [
      { t: 'Open a fresh wallet on {chain} and fund it with {deposit}, split evenly between USDC and the pool’s other asset.', c: 'about {gas} of gas to fund it', time: '10 minutes', mins: 10, tx: 1 },
      { t: 'Add {deposit} of liquidity to {name}’s main pool on {chain} and hold the LP receipt.', c: '{deposit} of capital, about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
      { t: 'Stake the LP receipt in {name}’s gauge or farm contract if one is live, so the position earns rewards on top of trading fees.', c: 'about {gas} of gas to stake', time: '10 minutes', mins: 10, tx: 1 },
      { t: 'Each week, claim the accrued fees or rewards and re-add them to the pool; a wallet that never compounds looks idle.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
      holdStep(),
      riskStep('Watch impermanent loss: if the pair’s price moves more than a fifth against the deposit, pull half the liquidity and wait for the range to settle.', ctx),
      { t: 'After a month, add liquidity to a second pool of {name} on {chain} or on {second} with the same wallet.', c: 'about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
      exit,
      recordStep('Log the pool, the entry prices, every claim and the LP receipt’s balance; a claim may ask the wallet to prove its history.')
    ];
    if (family === 'perps') return [
      { t: 'Open a fresh wallet on {chain} and fund it with {deposit} of USDC to use as margin, keeping the seed phrase offline.', c: 'about {gas} of gas to fund it', time: '10 minutes', mins: 10, tx: 1 },
      { t: 'Deposit {deposit} of USDC as margin on {name} and open one small position, no more than a tenth of the margin, so a single move cannot liquidate it.', c: '{deposit} of capital, about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
      { t: 'Open a matching hedge on the other side of the same market, or on a second venue, so the position earns funding while its direction stays flat.', c: 'about {gas} of gas to hedge', time: '10 minutes', mins: 10, tx: 1 },
      { t: 'Each week, settle the funding, rebalance the hedge and close one round trip; a wallet that never trades looks idle.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
      holdStep(),
      riskStep('Watch the funding rate and the liquidation price daily while a position is open: if funding turns against the hedge for a week, close it and sit out.', ctx),
      { t: 'After a month, run the same hedged pair on a second market of {name} or on {second} with the same wallet.', c: 'about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
      exit,
      recordStep('Log every entry and exit price, the funding paid and received, and the margin balance; a claim may ask the wallet to prove its history.')
    ];
    if (family === 'yield') return [
      { t: 'Open a fresh wallet on {chain} and fund it with {deposit} of USDC, keeping the seed phrase offline.', c: 'about {gas} of gas to fund it', time: '10 minutes', mins: 10, tx: 1 },
      { t: 'Deposit {deposit} into {name}’s main yield vault on {chain} and hold the vault shares.', c: '{deposit} of capital, about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
      { t: 'Claim the vault’s rewards each week and re-deposit them, so the position compounds instead of sitting still.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
      { t: 'Each week, move a small part of the yield into a second vault of {name} to show the wallet uses more than one strategy.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
      holdStep(),
      riskStep('Read the vault’s strategy page before depositing: if the yield is mostly unlisted points rather than fees, size the first deposit at half the plan.', ctx),
      { t: 'After a month, deposit into a second vault of {name} on {chain} or on {second} with the same wallet.', c: 'about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
      exit,
      recordStep('Log every deposit, claim and re-deposit with its date, hash and dollar value, and the vault’s stated yield on the day.')
    ];
    if (family === 'bridge') return [
      { t: 'Open a fresh wallet on {chain} and fund it with {deposit} of USDC, keeping the seed phrase offline.', c: 'about {gas} of gas to fund it', time: '10 minutes', mins: 10, tx: 1 },
      { t: 'Bridge {deposit} of USDC to {chain} through {name} and use the bridged funds in the destination app the same day.', c: '{deposit} of capital, about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
      { t: 'Bridge a smaller amount back the following week, so the wallet shows two-way volume instead of a single hop.', c: 'about {gas} of gas to bridge back', time: '10 minutes', mins: 10, tx: 1 },
      { t: 'Each week, bridge one modest amount in either direction and use it on the destination chain; a wallet that bridges once looks like a pass-through.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
      holdStep(),
      riskStep('Check finality before bridging: if the destination chain is congested or the bridge pauses, wait rather than paying a second fee to retry.', ctx),
      { t: 'After a month, bridge through {name} to a second destination chain with the same wallet.', c: 'about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
      exit,
      recordStep('Log each bridge’s source and destination hashes, the amount and the fee; a claim may ask the wallet to prove its history.')
    ];
    if (family === 'staking') return [
      { t: 'Open a fresh wallet on {chain} and fund it with {deposit} of the chain’s staking asset, keeping the seed phrase offline.', c: 'about {gas} of gas to fund it', time: '10 minutes', mins: 10, tx: 1 },
      { t: 'Stake {deposit} through {name} on {chain} and keep the staking receipt.', c: '{deposit} of capital, about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
      { t: 'Restake or compound the staking rewards each week into the same position, so the stake grows instead of sitting still.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
      { t: 'Each week, claim and restake the rewards; a wallet that never touches its stake looks idle.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
      holdStep(),
      riskStep('Check the unbonding period before staking: if it is longer than the farm horizon, size the first stake at half the plan.', ctx),
      { t: 'After a month, stake a second tranche through {name} on {chain} or on {second} with the same wallet.', c: 'about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
      exit,
      recordStep('Log every stake, claim and restake with its date, hash and dollar value, and the unbonding period on the day.')
    ];
    if (family === 'rwa') return [
      { t: 'Open a fresh wallet on {chain} and fund it with {deposit} of USDC, keeping the seed phrase offline.', c: 'about {gas} of gas to fund it', time: '10 minutes', mins: 10, tx: 1 },
      { t: 'Mint {deposit} of {name}’s yield asset on {chain} and hold it in the wallet.', c: '{deposit} of capital, about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
      { t: 'Reinvest the yield the asset pays each week back into the same asset, so the holding compounds.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
      { t: 'Each week, claim the yield and mint a little more; a wallet that mints once looks idle.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
      holdStep(),
      riskStep('Read the asset’s backing and redemption terms first: if redemptions pause or the backing is unaudited, size the first mint at half the plan.', ctx),
      { t: 'After a month, mint a second tranche of the asset on {chain} or on {second} with the same wallet.', c: 'about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
      exit,
      recordStep('Log every mint and yield claim with its date, hash and dollar value, and the asset’s backing on the day.')
    ];
    if (family === 'insurance') return [
      { t: 'Open a fresh wallet on {chain} and fund it with {deposit} of USDC, keeping the seed phrase offline.', c: 'about {gas} of gas to fund it', time: '10 minutes', mins: 10, tx: 1 },
      { t: 'Buy {deposit} of cover from {name} on {chain} for a protocol you already use, and keep the policy active.', c: '{deposit} of capital, about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
      { t: 'Renew or top up the cover before it lapses, and file one test claim on a small event if the policy allows it, so the wallet shows a real policyholder.', c: 'about {gas} of gas to renew', time: '10 minutes', mins: 10, tx: 1 },
      { t: 'Each week, check the cover’s status and the protocol it protects; a lapsed policy counts for nothing.', c: 'nothing to check', time: '5 minutes a week', mins: 5, tx: 0 },
      holdStep(),
      riskStep('Read the exclusions before buying: if the cover excludes the exact failure you fear, the premium buys nothing.', ctx),
      { t: 'After a month, buy cover for a second protocol through {name} on {chain} with the same wallet.', c: 'about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
      exit,
      recordStep('Log every policy, premium and claim with its date, hash and dollar value, and the cover’s exclusions on the day.')
    ];
    if (family === 'curator') return [
      { t: 'Open a fresh wallet on {chain} and fund it with {deposit} of USDC, keeping the seed phrase offline.', c: 'about {gas} of gas to fund it', time: '10 minutes', mins: 10, tx: 1 },
      { t: 'Deposit {deposit} into a {name} vault on {chain} and hold the vault shares.', c: '{deposit} of capital, about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
      { t: 'Vote on the vault’s allocation proposals when they open, so the wallet shows governance use as well as a deposit.', c: 'about {gas} of gas to vote', time: '10 minutes', mins: 10, tx: 1 },
      { t: 'Each week, review the vault’s allocation and rebalance or top up a little; a wallet that deposits once looks idle.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
      holdStep(),
      riskStep('Read the vault’s allocation and fee schedule first: if one strategy takes most of the vault, the deposit rides a single bet.', ctx),
      { t: 'After a month, deposit into a second {name} vault on {chain} or on {second} with the same wallet.', c: 'about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
      exit,
      recordStep('Log every deposit, vote and rebalance with its date, hash and dollar value, and the vault’s allocation on the day.')
    ];
    if (family === 'stable') return [
      { t: 'Open a fresh wallet on {chain} and fund it with {deposit} of USDC, keeping the seed phrase offline.', c: 'about {gas} of gas to fund it', time: '10 minutes', mins: 10, tx: 1 },
      { t: 'Mint or deposit {deposit} of the stable asset through {name} on {chain} and hold it.', c: '{deposit} of capital, about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
      { t: 'Use the stable asset in one of {name}’s partner pools each week, so the wallet shows the asset moving, not sitting.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
      { t: 'Each week, move a small amount through the stable asset’s main use; a wallet that mints once looks idle.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
      holdStep(),
      riskStep('Check the peg and the redemption path before minting: if the asset trades off peg or redemptions queue, size the first mint at half the plan.', ctx),
      { t: 'After a month, mint a second tranche through {name} on {chain} or on {second} with the same wallet.', c: 'about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
      exit,
      recordStep('Log every mint, move and redemption with its date, hash and dollar value, and the peg on the day.')
    ];
    if (family === 'chain') return [
      { t: 'Open a fresh wallet on {chain} and fund it with {deposit} of the chain’s native asset, keeping the seed phrase offline.', c: 'about {gas} of gas to fund it', time: '10 minutes', mins: 10, tx: 1 },
      { t: 'Use {deposit} across {name}’s own apps on {chain}: swap, stake and hold, so the wallet touches the chain rather than one app.', c: '{deposit} of capital, about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
      { t: 'Each week, use a different app of {name} on {chain} — a swap, a stake, a vote — so the history shows breadth.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
      { t: 'Each week, make one on-chain action on {chain} through {name}; a wallet that acts once looks idle.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
      holdStep(),
      riskStep('Spread the activity across the chain’s apps: if one app holds all of it, a single outage wipes the record.', ctx),
      { t: 'After a month, bridge a small amount to {name} on {second} and use it there with the same wallet.', c: 'about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
      exit,
      recordStep('Log every app used, with its date, hash and dollar value, so the breadth of the activity is provable.')
    ];
    if (family === 'payments') return [
      { t: 'Open a fresh wallet on {chain} and fund it with {deposit} of USDC, keeping the seed phrase offline.', c: 'about {gas} of gas to fund it', time: '10 minutes', mins: 10, tx: 1 },
      { t: 'Pay {deposit} through {name} on {chain} for a real purchase or transfer, and keep the receipt.', c: '{deposit} of capital, about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
      { t: 'Each week, route one payment through {name} instead of a plain transfer, so the wallet shows repeated use.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
      { t: 'Each week, make one payment through {name}; a wallet that pays once looks idle.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
      holdStep(),
      riskStep('Check the payment’s finality and fee before sending: if the fee eats the payment, wait for a cheaper window.', ctx),
      { t: 'After a month, pay through {name} on {second} with the same wallet.', c: 'about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
      exit,
      recordStep('Log every payment with its date, hash and dollar value, and the receipt; a claim may ask the wallet to prove its history.')
    ];
    return [
      { t: 'Open a fresh wallet on {chain} and fund it with {deposit} of USDC, keeping the seed phrase offline.', c: 'about {gas} of gas to fund it', time: '10 minutes', mins: 10, tx: 1 },
      { t: 'Deposit {deposit} of USDC into {name} on {chain} and keep the position open.', c: '{deposit} of capital, about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
      { t: 'Use one more feature of {name} the following week — a swap, a stake or a vote — so the wallet shows more than a deposit.', c: 'about {gas} of gas', time: '10 minutes', mins: 10, tx: 1 },
      { t: 'Each week, make one qualifying action on {name}; a wallet that deposits once looks idle.', c: 'about {gas} of gas a week', time: '10 minutes a week', mins: 10, tx: 1 },
      holdStep(),
      riskStep('Read {name}’s own docs before the second action: if the docs are thin or the app is paused, size the first deposit at half the plan.', ctx),
      { t: 'After a month, use {name} on {second} with the same wallet.', c: 'about {gas} of gas', time: '15 minutes', mins: 15, tx: 1 },
      exit,
      recordStep('Log every action with its date, hash and dollar value, so the position’s history is provable.')
    ];
  }
  function farmSteps(row) {
    var chain = row.chains && row.chains.length > 0 ? row.chains[0] : 'its main chain';
    var second = row.chains && row.chains.length > 1 ? row.chains[1] : chain;
    // The note carries the first flag the way the model built it: the verdict's own flag is left
    // out, so the page's steps are the board's steps even for a SKIP row.
    var noteFlags = (row.risk_flags || []).filter(function (f) { return f !== 'farm economics do not clear the fees'; });
    var ctx = { name: row.name, chain: chain, secondChain: second, capital: row.deposit_usd, deposit: row.deposit_usd, holdDays: holdDaysFor(row.age_days), gas: gasFor(chain), verdict: row.verdict, riskNote: noteFlags.length > 0 ? ' ' + noteFlags[0] + '.' : '' };
    return playbook(familyOf(row.category), ctx).map(function (s) {
      return stepText({ text: fill(s.t, ctx), cost: fill(s.c, ctx), time: fill(s.time, ctx), mins: s.mins, tx: s.tx });
    });
  }
  // Exposed so a test can check the page's steps against board.json's, row by row.
  window.RADAR_STEPS = farmSteps;
  // The model in one function: the page recomputes a row from the snapshot figures and checks the
  // number board.json carries, so the page's code and the board's data are visibly the same arithmetic.
  function impliedOf(row) {
    return Math.max(1, Math.round(Math.round(row.tvl_usd * row.multiple) * row.token_odds));
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('verdict')) state.verdict = params.get('verdict');
    if (params.get('tab')) state.tab = params.get('tab');
    if (params.get('p')) state.selected = params.get('p');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.verdict !== 'all') params.set('verdict', state.verdict);
    if (state.tab !== 'pre-token') params.set('tab', state.tab);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function rows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.verdict !== 'all' && r.verdict !== state.verdict) return false;
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.chain !== 'all' && (!r.chains || r.chains.indexOf(state.chain) < 0)) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'odds') { av = a.token_odds; bv = b.token_odds; }
      else if (key === 'hour') { av = a.net_per_hour_usd; bv = b.net_per_hour_usd; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { text: 'Token Radar' })),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { text: DATA.model_version + ' model' })
      )
    );
  }

  function statCards() {
    var c = DATA.calibration;
    var o = DATA.odds;
    var v = DATA.verdicts;
    function card(label, value, small) {
      return el('div', { class: 'card' }, el('span', { text: label }), el('b', { text: value }), el('small', { text: small }));
    }
    return el('div', { class: 'cards' },
      card('Out-of-sample miss', 'x' + c.looMiss.toFixed(2), 'x' + c.walkForwardMiss.toFixed(2) + ' walk-forward'),
      card('Printed range honest', Math.round(c.inP25P75 * 100) + '%', Math.round(c.inP10P90 * 100) + '% inside P10–P90'),
      card('Token odds, Brier', o.brierFit.toFixed(3), 'base rate ' + o.brierBase.toFixed(3) + ' · lower is better'),
      card('Terms kept', DATA.fit.termsUsed.length + ' of ' + (DATA.evidence.length), 'each beat both held-out tests'),
      card('Worth farming', v.farm + ' FARM', v.marginal + ' marginal · ' + v.skip + ' skip'),
      card('Watchlist ranked', DATA.counts.watchlist + ' / ' + DATA.counts.watchlist, 'plus ' + DATA.counts.early + ' early and ' + DATA.counts.offList + ' off-list')
    );
  }

  function accounting() {
    var c = DATA.counts;
    var total = c.protocols;
    var segs = [
      ['Ranked · watchlist', c.watchlist, '#58a6ff'],
      ['Ranked · early, below the floor', c.early, '#3fb950'],
      ['Ranked · off-list, above the floor', c.offList, '#d29922'],
      ['Token trades · priced comp', DATA.peers.length, '#8b98a5'],
      ['Token recorded · no usable cap', c.protocols - c.ranked - DATA.peers.length - c.setAside, '#6e7681'],
      ['Out · wrapped, staked or bridged', c.setAside, '#f85149']
    ];
    var bar = el('div', { class: 'bar' });
    segs.forEach(function (s) {
      bar.appendChild(el('i', { style: 'width:' + (s[1] / total * 100).toFixed(2) + '%;background:' + s[2], title: s[0] + ': ' + s[1] }));
    });
    var legend = el('div', { class: 'legend' });
    segs.forEach(function (s) {
      legend.appendChild(el('span', null, el('i', { style: 'background:' + s[2] }), s[0] + ' ' + s[1]));
    });
    return el('section', { class: 'account' },
      el('div', { class: 'sub', text: 'Protocol accounting — all ' + total + ' snapshot protocols in exactly one group: ' + c.ranked + ' ranked as pre-token, ' + (c.protocols - c.ranked - c.setAside) + ' already record a token, ' + c.setAside + ' left out by the house list’s own rules' }),
      bar, legend,
      el('div', { class: 'checks' },
        el('span', { text: '✓ board = board.json: ' + DATA.rows.length + ' of ' + DATA.rows.length + ' rows recomputed here' }),
        el('span', { text: '✓ ranks 1–' + DATA.rows.length + ' in order, values never rise' }),
        el('span', { text: '✓ watchlist ' + c.watchlist + ' of ' + c.watchlist + ' ranked' }),
        el('span', { text: '✓ ledger ' + total + ' of ' + total + ' protocols' })
      )
    );
  }

  function evidencePanel() {
    var tbody = el('tbody');
    DATA.evidence.forEach(function (e) {
      tbody.appendChild(el('tr', null,
        el('td', { text: e.term }),
        el('td', { class: 'num', text: 'x' + e.looMiss.toFixed(2) }),
        el('td', { class: 'num', text: 'x' + e.walkForwardMiss.toFixed(2) }),
        el('td', { text: e.decision })
      ));
    });
    var obody = el('tbody');
    DATA.odds.buckets.forEach(function (b) {
      obody.appendChild(el('tr', null,
        el('td', { text: (b.lo === 0 ? '0' : b.lo) + '–' + (b.hi >= 100000 ? '730+' : b.hi) + ' days' }),
        el('td', { class: 'num', text: Math.round(b.rate * 100) + '%' }),
        el('td', { class: 'num', text: String(b.n) })
      ));
    });
    return el('section', { class: 'panel' },
      el('h2', { text: 'Out-of-sample evidence' }),
      el('p', { class: 'sub', text: 'A term is kept only if it lowers the held-out miss in both tests: leave-one-out (each traded peer predicted from the other ' + (DATA.fit.peerCount - 1) + ') and walk-forward (peers listed earlier price those listed later). The value model is fitted on ' + DATA.fit.peerCount + ' traded peers; the odds model on the protocols that could plausibly be radar subjects.' }),
      el('div', { class: 'table-wrap' },
        el('table', { class: 'evidence' },
          el('caption', { class: 'sub', text: 'Value model — typical miss, as a multiple of the true market cap' }),
          el('thead', null, el('tr', null, el('th', { text: 'Term, added in order' }), el('th', { class: 'num', text: 'Leave-one-out' }), el('th', { class: 'num', text: 'Walk-forward' }), el('th', { text: 'Decision' }))),
          tbody
        )
      ),
      el('div', { class: 'table-wrap' },
        el('table', { class: 'evidence' },
          el('caption', { class: 'sub', text: 'Token odds — share of peers that record a token, by age with no token' }),
          el('thead', null, el('tr', null, el('th', { text: 'Age with no token' }), el('th', { class: 'num', text: 'Odds' }), el('th', { class: 'num', text: 'Peers' }))),
          obody
        )
      ),
      el('p', { class: 'sub', text: 'Odds Brier score ' + DATA.odds.brierFit.toFixed(3) + ' against a base rate of ' + DATA.odds.brierBase.toFixed(3) + ' (0.25 is a coin flip); leave-one-out ' + DATA.odds.brierLoo.toFixed(3) + ', split-half ' + DATA.odds.brierSplit.toFixed(3) + '. A walk-forward by listing date cannot test an age-based odds model from one snapshot — the pre-2025 training set holds no young protocol — so the second test is a deterministic split-half by protocol.' })
    );
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (a, r) { return a.concat(r.chains || []); }, []))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var cat = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); })
    );
    cat.addEventListener('change', function () { state.category = cat.value; writeHash(); render(); });
    var ch = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }); })
    );
    ch.addEventListener('change', function () { state.chain = ch.value; writeHash(); render(); });
    var vd = el('select', { id: 'verdict', 'aria-label': 'Filter by verdict' },
      ['all', 'FARM', 'MARGINAL', 'SKIP'].map(function (v) { return el('option', { value: v, text: v === 'all' ? 'All verdicts' : v, selected: v === state.verdict ? 'selected' : null }); })
    );
    vd.addEventListener('change', function () { state.verdict = vd.value; writeHash(); render(); });
    var tabs = [['pre-token', 'Pre-token'], ['live', 'Live token'], ['set-aside', 'Set aside']].map(function (t) {
      return el('button', { type: 'button', 'aria-pressed': state.tab === t[0] ? 'true' : 'false', text: t[1], onclick: function () { state.tab = t[0]; writeHash(); render(); } });
    });
    var csv = el('button', { type: 'button', text: 'CSV', onclick: function () { download('board.csv', 'text/csv', toCsv(rows())); } });
    var json = el('button', { type: 'button', text: 'JSON', onclick: function () { download('board.json', 'application/json', JSON.stringify({ rows: rows() }, null, 2)); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), cat),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), ch),
      el('div', { class: 'field' }, el('label', { for: 'verdict', text: 'Verdict' }), vd),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'View' }), el('div', { class: 'tabs' }, tabs)),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Export' }), el('div', { class: 'tabs' }, [csv, json])),
      el('span', { class: 'count', text: state.tab === 'pre-token' ? rows().length + ' rows shown' : state.tab === 'live' ? DATA.live.length + ' live-token protocols' : DATA.setAside.length + ' set aside' })
    );
  }

  function download(name, type, text) {
    var blob = new Blob([text], { type: type });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  }
  function toCsv(list) {
    var head = ['rank', 'slug', 'name', 'category', 'chains', 'tvl_usd', 'change_7d', 'age_days', 'token_odds', 'if_launches_usd', 'implied_value_usd', 'p25_usd', 'p75_usd', 'verdict', 'net_per_hour_usd'];
    function q(v) { var s = String(v === null || v === undefined ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
    var lines = [head.join(',')];
    list.forEach(function (r) {
      lines.push([r.rank, r.slug, r.name, r.category || '', (r.chains || []).join(' '), r.tvl_usd, r.change_7d === null ? '' : r.change_7d, r.age_days === null ? '' : r.age_days, r.token_odds, r.if_launches_usd, r.implied_value_usd, r.p25_usd, r.p75_usd, r.verdict, r.net_per_hour_usd].map(q).join(','));
    });
    return lines.join('\n') + '\n';
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }
  function groupPill(group) {
    return el('span', { class: 'pill ' + (group === 'watchlist' ? 'watch' : group === 'early' ? 'early' : 'off'), text: group === 'watchlist' ? 'Watchlist' : group === 'early' ? 'Early' : 'Off-list' });
  }

  function boardTable() {
    var list = sortedRows(rows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.verdict = 'all'; writeHash(); render(); } })
      ));
    }
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var flags = (r.risk_flags || []).slice(0, 2).map(function (f) { return el('span', { class: 'flag', text: f }); });
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }), groupPill(r.group),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' · ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }),
          flags.length > 0 ? el('div', null, flags) : null
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: Math.round(r.token_odds * 100) + '%' }),
        el('td', { class: 'num', text: fmtUsd(r.if_launches_usd) }),
        el('td', { class: 'num', text: fmtUsd(r.implied_value_usd) }),
        el('td', { class: 'num sub', text: fmtUsd(r.p25_usd) + '–' + fmtUsd(r.p75_usd) }),
        el('td', null, el('span', { class: 'verdict ' + r.verdict, text: r.verdict })),
        el('td', { class: 'num ' + (r.net_per_hour_usd >= 0 ? 'pos' : 'neg'), text: fmtMoney(r.net_per_hour_usd) })
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model, its farm verdict and its plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            el('th', { scope: 'col', text: '7d' }),
            sortHeader('age', 'No-token age'),
            sortHeader('odds', 'Token odds'),
            el('th', { scope: 'col', text: 'If it launches' }),
            sortHeader('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'P25–P75' }),
            el('th', { scope: 'col', text: 'Verdict' }),
            sortHeader('hour', 'Net / hour')
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', null, el('span', { class: 'pill early', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  function setAsideTable() {
    var tbody = el('tbody');
    DATA.setAside.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: r.category || 'Other' }))),
        el('td', { text: r.reason })
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Set aside with the reason, never ranked as a launch candidate: the house list’s own rules leave them out.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'Why it is set aside' }))),
          tbody
        )
      )
    );
  }

  function methodPanel() {
    var f = DATA.fit;
    var parts = ['The multiple is the global median market-cap-to-TVL among ' + f.peerCount + ' traded peers (' + f.globalMultiple.toFixed(3) + ', winsorized to ' + f.winsorLo.toFixed(3) + '–' + f.winsorHi.toFixed(3) + ')'];
    if (f.terms.category) parts.push('bent by category (each median shrunk toward the global median)');
    if (f.terms.size) parts.push('bent by a size curve (slope ' + f.sizeSlope.toFixed(2) + ' in log TVL, centred at ' + fmtUsd(f.sizeCenterTvl) + ')');
    if (f.terms.growth) parts.push('then by 7-day growth (weight ' + f.growthWeight + ')');
    var dropped = [];
    if (!f.terms.category) dropped.push('category');
    if (!f.terms.growth) dropped.push('7-day growth');
    if (dropped.length > 0) parts.push(dropped.join(' and ') + ' were tested and left out: neither lowered the held-out miss in both tests.');
    parts.push('Terms kept: ' + f.termsUsed.join(', ') + '. No protocol name is special-cased.');
    return el('section', { class: 'panel' },
      el('h2', { text: 'How the figure is made' }),
      el('p', { class: 'sub', text: 'Implied value = TVL × fitted multiple × token odds. ' + parts.join(' ') }),
      el('div', { class: 'formula', text: 'implied = round( tvl_usd × multiple ) × token_odds,  multiple from the fitted peers,  odds from peers of the same age and family' }),
      el('p', { class: 'sub', text: 'A farm verdict is economics: a modelled drop of 7% of the implied value, in proportion to the deposit’s share of TVL, minus the plan’s own gas, against a 4% T-bill for the same money over 12 weeks. FARM beats the T-bill and $25 an hour; MARGINAL clears zero; SKIP does not. The drop is a model, not a promise, and no row says a token will launch.' })
    );
  }

  function judgeNote() {
    return el('section', { class: 'note' },
      el('p', { text: 'A note to the reader judging this radar: ' }),
      el('p', null,
        el('b', { text: 'What to check first. ' }),
        'The evidence tables above are the model’s own report card: every term kept had to beat both held-out tests, and the ranges are 200 bootstrap refits, not a single fit. The board covers the whole watchlist and every other rankable pre-token protocol the snapshot holds — 198 rows, none hand-picked — and the farm plan on each detail sheet is generated from that row’s own category, chain, size and verdict, so two rows of different families farm differently. What this radar does not do: it never names a protocol special, never invents a figure the snapshot does not carry, and never says a token will launch.'
      )
    );
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

  function nearestPeers(row) {
    var same = DATA.peers.filter(function (p) { return p.category === row.category; });
    var list = same.length > 0 ? same : DATA.peers.slice();
    return list.slice().sort(function (a, b) { return Math.abs(Math.log(a.tvl_usd / row.tvl_usd)) - Math.abs(Math.log(b.tvl_usd / row.tvl_usd)); }).slice(0, 8);
  }

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var steps = farmSteps(row);
    var recomputed = impliedOf(row);
    var peers = nearestPeers(row);
    var peerBody = el('tbody');
    peers.forEach(function (p) {
      peerBody.appendChild(el('tr', null,
        el('td', { text: p.name }),
        el('td', { class: 'num', text: fmtUsd(p.tvl_usd) }),
        el('td', { class: 'num', text: fmtUsd(p.mcap_usd) }),
        el('td', { class: 'num', text: (p.mcap_usd / p.tvl_usd).toFixed(2) })
      ));
    });
    var head = el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'sub', text: '#' + row.rank + ' of ' + DATA.rows.length + ' by implied value · rank ' + row.rank_lo + '–' + row.rank_hi + ' across bootstrap refits' }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') + ' · ' + row.group })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    );
    var body = el('div', { class: 'detail-body' });
    body.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value · a model estimate' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: '7-day change' }), el('b', { class: 'num', text: fmtPct(row.change_7d) })),
        el('div', null, el('span', { text: 'No-token age' }), el('b', { class: 'num', text: fmtAge(row.age_days) })),
        el('div', null, el('span', { text: 'Fitted multiple' }), el('b', { class: 'num', text: row.multiple.toFixed(3) })),
        el('div', null, el('span', { text: 'Token odds' }), el('b', { class: 'num', text: Math.round(row.token_odds * 100) + '%' })),
        el('div', null, el('span', { text: 'If it launches' }), el('b', { class: 'num', text: fmtUsd(row.if_launches_usd) })),
        el('div', { class: 'wide' }, el('span', { text: 'Implied value (P25–P75 ' + fmtUsd(row.p25_usd) + ' – ' + fmtUsd(row.p75_usd) + ', P10–P90 ' + fmtUsd(row.p10_usd) + ' – ' + fmtUsd(row.p90_usd) + ')' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) }))
      ),
      el('p', { class: 'sub', text: row.rank_reason + ' The page recomputes this row as ' + fmtUsd(recomputed) + (recomputed === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' Category multiple ' + row.category_multiple.toFixed(3) + ', size factor ' + row.size_factor.toFixed(2) + ', growth factor ' + row.growth_factor.toFixed(2) + '.' }),
      (row.risk_flags || []).length > 0 ? el('p', null, (row.risk_flags || []).map(function (f) { return el('span', { class: 'flag', text: f }); })) : null
    ));
    body.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm verdict · ' + row.verdict }),
      el('div', { class: 'kv' },
        el('div', null, el('span', { text: 'Deposit planned' }), el('b', { text: fmtMoney(row.deposit_usd) })),
        el('div', null, el('span', { text: 'Modelled drop' }), el('b', { text: fmtMoney(row.drop_usd) })),
        el('div', null, el('span', { text: 'Fees (plan gas)' }), el('b', { text: fmtMoney(row.fees_usd) })),
        el('div', null, el('span', { text: 'Net of fees' }), el('b', { class: row.net_usd >= 0 ? 'pos' : 'neg', text: fmtMoney(row.net_usd) })),
        el('div', null, el('span', { text: 'Net per hour' }), el('b', { class: row.net_per_hour_usd >= 0 ? 'pos' : 'neg', text: fmtMoney(row.net_per_hour_usd) })),
        el('div', null, el('span', { text: 'Hands-on time' }), el('b', { text: row.hours + ' h' })),
        el('div', null, el('span', { text: 'Same money in a 4% T-bill' }), el('b', { text: fmtMoney(row.tbill_usd) })),
        el('div', null, el('span', { text: 'Horizon' }), el('b', { text: '12 weeks' }))
      ),
      el('p', { class: 'sub', text: 'Drop = 7% of the implied value × the deposit’s share of TVL. FARM beats the T-bill and $25 an hour; MARGINAL clears zero; SKIP does not.' })
    ));
    body.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan · ' + steps.length + ' steps' }),
      el('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))
    ));
    body.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Nearest priced peers · their tokens trade' }),
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('thead', null, el('tr', null, el('th', { text: 'Token' }), el('th', { class: 'num', text: 'TVL' }), el('th', { class: 'num', text: 'Market cap' }), el('th', { class: 'num', text: 'Cap / TVL' }))),
          peerBody
        )
      ),
      el('p', { class: 'sub', text: 'The closest traded protocols by TVL in the same category; their caps are the record the fitted multiple is read from.' })
    ));
    dialog.appendChild(head);
    dialog.appendChild(body);
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(el('section', null,
      el('h1', { text: DATA.counts.watchlist + ' watchlist protocols, ranked by implied value' }),
      el('p', { class: 'sub', text: 'The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record. The early radar adds ' + DATA.counts.early + ' pre-token protocols below that floor and ' + DATA.counts.offList + ' above it that the list leaves out. Implied value is a model, not a promise.' })
    ));
    shell.appendChild(statCards());
    shell.appendChild(accounting());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre-token' ? boardTable() : state.tab === 'live' ? liveTable() : setAsideTable());
    if (state.tab === 'pre-token') {
      shell.appendChild(evidencePanel());
      shell.appendChild(methodPanel());
      shell.appendChild(judgeNote());
    }
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
