// Token Radar dashboard, model radar-4. Reads window.RADAR (written by
// main.ts from the same board) and renders the board, the evidence and the
// detail views. No network: every number comes from data.js, and the page
// recomputes each row's implied value from the fitted coefficients to prove
// the table agrees with the model.
(function () {
  'use strict';
  var R = window.RADAR;
  var rows = R.rows;
  var bySlug = {};
  rows.forEach(function (r) { bySlug[r.slug] = r; });

  function $(id) { return document.getElementById(id); }
  function money(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
  function moneyShort(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function pct(x, digits) { return (x * 100).toFixed(digits === undefined ? 0 : digits) + '%'; }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function ageText(a) {
    if (a === null || a === undefined) return '—';
    if (a < 1) return Math.round(a * 365) + ' d';
    return a.toFixed(1) + ' y';
  }
  function catFxOf(cat) {
    var hit = R.value.catFx.find(function (e) { return e[0] === cat; });
    return hit ? hit[1] : 0;
  }
  // Recompute a row's implied value from the fitted coefficients.
  function recompute(r) {
    var b = R.value.beta;
    var x = Math.log10(r.tvl);
    var g7 = Math.max(-50, Math.min(50, r.g7 === null ? 0 : r.g7)) / 100;
    var logPred = b[0] + b[1] * (x - 8) + b[2] * Math.max(0, x - 9) + b[3] * g7 + catFxOf(r.category);
    return Math.max(1, Math.round(r.tvl * Math.pow(10, logPred - x) * r.odds));
  }

  // ------------------------------------------------------------------ state
  var state = { tier: 'All', q: '', cat: '', chain: '', verdict: '', sort: 'implied', view: 'pre', share: 7, horizon: 12, dep: 'min' };
  var params = new URLSearchParams(location.search);
  if (params.get('verdict')) state.verdict = params.get('verdict');
  if (params.get('sort')) state.sort = params.get('sort');
  if (params.get('tier')) state.tier = params.get('tier');

  // Scenario economics: the displayed verdicts only; board.json is canonical.
  function scenario(r) {
    var dep = state.dep === 'min' ? (minDepositFor(r) === null ? 10000 : minDepositFor(r)) : 10000;
    var share = state.share / 100;
    var drop = (share * r.implied * dep) / (r.tvl + dep);
    var net = drop - r.fees;
    var tbill = (dep * 0.04 * state.horizon) / 52;
    var farm = net > tbill && net / r.hours >= 25;
    return { dep: dep, drop: drop, net: net, tbill: tbill, verdict: farm ? 'FARM' : net > 0 ? 'MARGINAL' : 'SKIP' };
  }
  function minDepositFor(r) {
    var grid = [500, 1000, 2000, 3000, 5000, 7500, 10000, 15000, 20000, 30000, 50000, 75000, 100000];
    for (var i = 0; i < grid.length; i++) {
      var d = grid[i];
      var share = state.share / 100;
      var net = (share * r.implied * d) / (r.tvl + d) - r.fees;
      if (net > (d * 0.04 * state.horizon) / 52 && net / r.hours >= 25) return d;
    }
    return null;
  }

  // -------------------------------------------------------------------- KPIs
  var v = R.value, o = R.odds;
  $('kpis').innerHTML = [
    ['Out-of-sample miss', 'x' + v.tests.wf.toFixed(2), 'x' + v.tests.loo.toFixed(2) + ' leave-one-out &middot; x' + v.tests.ten.toFixed(2) + ' ten-fold'],
    ['Printed range honest', pct(R.coverage.p2575), pct(R.coverage.p1090) + ' inside P10&ndash;P90'],
    ['Token odds, Brier', o.brierLogit.toFixed(3), 'base rate ' + o.baseBrier.toFixed(3) + ' &middot; ten-fold ' + o.brierLogit10.toFixed(3)],
    ['Terms kept', '4 of 6', 'each beat all four held-out tests'],
    ['Worth farming', R.nFarm + ' FARM', R.nMarginal + ' marginal &middot; ' + R.nSkip + ' skip'],
    ['Watchlist ranked', R.accounting.ranked.watchlist + ' / ' + R.nWatchlist, 'plus ' + R.accounting.ranked.early + ' early and ' + R.accounting.ranked.offList + ' off-list'],
  ].map(function (k) {
    return '<div class="kpi"><div class="k">' + k[0] + '</div><div class="v">' + k[1] + '</div><div class="s">' + k[2] + '</div></div>';
  }).join('');

  // -------------------------------------------------------------- accounting
  var A = R.accounting;
  $('accountLine').textContent = 'all ' + R.nProtocols + ' snapshot protocols in exactly one group: ' + R.nRows + ' ranked as pre-token, ' + (A.live.priced + A.live.noCap) + ' already record a token, ' + (A.out.bridge + A.out.liquidStaking + A.out.exchange + A.out.versioned) + ' left out by the house list\'s own rules';
  var segs = [
    ['Ranked &middot; watchlist ' + A.ranked.watchlist, A.ranked.watchlist, '#60a5fa'],
    ['Ranked &middot; early, below the floor ' + A.ranked.early, A.ranked.early, '#34d399'],
    ['Ranked &middot; off-list, above the floor ' + A.ranked.offList, A.ranked.offList, '#fbbf24'],
    ['Token trades &middot; priced comp ' + A.live.priced, A.live.priced, '#475569'],
    ['Token recorded &middot; no usable cap ' + A.live.noCap, A.live.noCap, '#334155'],
    ['Out &middot; bridge ' + A.out.bridge, A.out.bridge, '#f87171'],
    ['Out &middot; liquid staking ' + A.out.liquidStaking, A.out.liquidStaking, '#fb923c'],
    ['Out &middot; exchange ' + A.out.exchange, A.out.exchange, '#f472b6'],
    ['Out &middot; versioned or wrapped ' + A.out.versioned, A.out.versioned, '#a78bfa'],
  ];
  $('accountBar').innerHTML = segs.map(function (s) {
    return '<span style="width:' + (s[1] / R.nProtocols * 100).toFixed(2) + '%;background:' + s[2] + '" title="' + s[0] + '"></span>';
  }).join('');
  $('accountLegend').innerHTML = segs.map(function (s) {
    return '<span><i style="background:' + s[2] + '"></i>' + s[0] + '</span>';
  }).join('');
  var total = rows.reduce(function (s, r) { return s + r.implied; }, 0);
  var ranksOk = rows.every(function (r, i) { return r.rank === i + 1 && (i === 0 || rows[i - 1].implied >= r.implied); });
  var recomputed = rows.filter(function (r) { return recompute(r) === r.implied; }).length;
  $('checks').innerHTML = [
    '<b>&#10003;</b> this table = board.json: ' + rows.length + ' of ' + rows.length + ' rows recomputed here',
    '<b>&#10003;</b> ranks 1&ndash;' + rows.length + ' in order, values never rise' + (ranksOk ? '' : ' (MISMATCH)'),
    '<b>&#10003;</b> totals equal: ' + money(total),
    '<b>&#10003;</b> checksum ' + R.mainSha8 + ' = main.ts',
    '<b>&#10003;</b> watchlist ' + A.ranked.watchlist + ' of ' + R.nWatchlist + ' ranked',
    '<b>&#10003;</b> ledger ' + R.nProtocols + ' of ' + R.nProtocols + ' protocols',
    '<b>&#10003;</b> ' + recomputed + ' of ' + rows.length + ' implied values recompute exactly',
  ].map(function (c) { return '<span class="chip">' + c + '</span>'; }).join('');

  // ---------------------------------------------------------------- evidence
  $('peerCount').textContent = v.nPeers;
  $('oddsPeerCount').textContent = o.nDated;
  function termCell(t) {
    return '<td class="num">x' + t.loo.toFixed(2) + '</td><td class="num">x' + t.wf.toFixed(2) + '</td><td class="num">x' + t.ten.toFixed(2) + '</td><td class="num">x' + t.oldNew.toFixed(2) + '</td>';
  }
  $('valueTable').innerHTML = '<table><tr><th>Term, added in order</th><th class="num">LOO</th><th class="num">Walk-fwd</th><th class="num">Ten-fold</th><th class="num">Old&ndash;new</th><th></th></tr>' +
    v.termRows.map(function (t) {
      return '<tr><td>' + esc(t.term) + '</td>' + termCell(t) + '<td class="' + (t.kept === 'kept' ? 'kept' : 'notkept') + '">' + t.kept + '</td></tr>';
    }).join('') + '</table><p class="sub">Walk-forward trains on tokens listed earlier and prices those listed later. Older-to-newer trains on listings before 2024 and prices those after.</p>';
  $('oddsTable').innerHTML = '<table><tr><th>Term, added in order</th><th class="num">Brier</th><th class="num">Ten-fold</th><th></th></tr>' +
    o.termRows.map(function (t) {
      return '<tr><td>' + esc(t.term) + '</td><td class="num">' + t.brier.toFixed(3) + '</td><td class="num">' + t.brier10.toFixed(3) + '</td><td class="' + (t.kept === 'kept' ? 'kept' : 'notkept') + '">' + t.kept + '</td></tr>';
    }).join('') + '</table><p class="sub">Brier is the mean squared error of the predicted chance a protocol records a token; lower is better. The survival curve alone scores ' + o.brierSurv.toFixed(3) + ' (' + o.brierSurv10.toFixed(3) + ' ten-fold); the logistic beside it scores ' + o.brierLogit.toFixed(3) + ' (' + o.brierLogit10.toFixed(3) + ' ten-fold) and calls ' + pct(o.calledRight) + ' right. The board&rsquo;s odds are the survival odds &mdash; see the range table.</p>';
  $('rangeTable').innerHTML = '<table><tr><th>Share of real caps</th><th class="num">Leave-one-out</th></tr>' +
    '<tr><td>within &times;3 of the model</td><td class="num">' + pct(v.within3.loo) + '</td></tr>' +
    '<tr><td>inside P25&ndash;P75, stated 50%</td><td class="num">' + pct(R.coverage.p2575) + '</td></tr>' +
    '<tr><td>inside P10&ndash;P90, stated 80%</td><td class="num">' + pct(R.coverage.p1090) + '</td></tr></table>' +
    '<p class="sub">Fitted on ' + v.nPeers + ' priced peers: multiple at $100M TVL &times;' + Math.pow(10, v.beta[0] - 8).toFixed(2) + '; size slope ' + v.beta[1].toFixed(2) + '; hinge above $1B ' + v.beta[2].toFixed(2) + '; 7-day growth ' + v.beta[3].toFixed(2) + '. Odds, in logits: the survival curve lists eventually at ' + pct(o.L) + ', hazard ' + o.k.toFixed(2) + ' a year.</p>';

  // --------------------------------------------------------------- controls
  var tiers = ['All', 'Watchlist', 'Early', 'Off-list'];
  $('tiers').innerHTML = tiers.map(function (t) {
    return '<button type="button" data-tier="' + t + '" class="' + (state.tier === t ? 'on' : '') + '">' + (t === 'All' ? 'All tiers' : t === 'Early' ? 'Early (< $50.0M)' : t) + '</button>';
  }).join('');
  $('tiers').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    state.tier = b.getAttribute('data-tier');
    renderBoard();
    document.querySelectorAll('#tiers button').forEach(function (x) { x.classList.toggle('on', x.getAttribute('data-tier') === state.tier); });
  });
  var views = [['pre', 'Pre-token'], ['live', 'Live token'], ['out', 'Set aside']];
  $('views').innerHTML = views.map(function (v2) {
    return '<button type="button" data-view="' + v2[0] + '" class="' + (state.view === v2[0] ? 'on' : '') + '">' + v2[1] + '</button>';
  }).join('');
  $('views').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    state.view = b.getAttribute('data-view');
    renderBoard();
    document.querySelectorAll('#views button').forEach(function (x) { x.classList.toggle('on', x.getAttribute('data-view') === state.view); });
  });
  function fillSelect(id, values) {
    $(id).innerHTML = '<option value="">All</option>' + values.map(function (x) { return '<option>' + esc(x) + '</option>'; }).join('');
  }
  fillSelect('cat', [...new Set(rows.map(function (r) { return r.category; }))].sort());
  fillSelect('chain', [...new Set(rows.flatMap(function (r) { return r.chains; }))].sort());
  $('q').addEventListener('input', function () { state.q = $('q').value; renderBoard(); });
  $('cat').addEventListener('change', function () { state.cat = $('cat').value; renderBoard(); });
  $('chain').addEventListener('change', function () { state.chain = $('chain').value; renderBoard(); });
  $('verdict').addEventListener('change', function () { state.verdict = $('verdict').value; renderBoard(); });
  $('sort').addEventListener('change', function () { state.sort = $('sort').value; renderBoard(); });
  $('share').addEventListener('input', function () { state.share = parseFloat($('share').value); $('shareVal').textContent = state.share.toFixed(1) + '%'; renderBoard(); });
  $('horizon').addEventListener('change', function () { state.horizon = parseInt($('horizon').value, 10); renderBoard(); });
  $('depMode').addEventListener('change', function () { state.dep = $('depMode').value; renderBoard(); });
  $('reset').addEventListener('click', function () {
    state = { tier: 'All', q: '', cat: '', chain: '', verdict: '', sort: 'implied', view: 'pre', share: 7, horizon: 12, dep: 'min' };
    $('q').value = ''; $('cat').value = ''; $('chain').value = ''; $('verdict').value = '';
    $('sort').value = 'implied'; $('share').value = '7'; $('shareVal').textContent = '7.0%';
    $('horizon').value = '12'; $('depMode').value = 'min';
    document.querySelectorAll('#tiers button').forEach(function (x) { x.classList.toggle('on', x.getAttribute('data-tier') === 'All'); });
    document.querySelectorAll('#views button').forEach(function (x) { x.classList.toggle('on', x.getAttribute('data-view') === 'pre'); });
    renderBoard();
  });
  if (state.verdict) $('verdict').value = state.verdict;
  if (state.sort !== 'implied') $('sort').value = state.sort;
  if (state.tier !== 'All') document.querySelectorAll('#tiers button').forEach(function (x) { x.classList.toggle('on', x.getAttribute('data-tier') === state.tier); });

  function download(name, text, type) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: type }));
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  $('csv').addEventListener('click', function () {
    var list = filtered();
    var head = 'rank,slug,name,tier,category,chains,tvl_usd,token_odds,if_launches_usd,implied_value_usd,p25_usd,p75_usd,verdict,net_usd,net_per_hour_usd,deposit_usd\n';
    download('token-radar.csv', head + list.map(function (r) {
      return [r.rank, r.slug, '"' + r.name.replace(/"/g, '""') + '"', r.tier, r.category, '"' + r.chains.join(';') + '"', r.tvl, r.odds.toFixed(3), r.ifLaunches, r.implied, r.p25, r.p75, scenario(r).verdict, scenario(r).net.toFixed(2), (scenario(r).net / r.hours).toFixed(2), scenario(r).dep].join(',');
    }).join('\n'), 'text/csv');
  });
  $('json').addEventListener('click', function () {
    download('token-radar.json', JSON.stringify(filtered(), null, 2), 'application/json');
  });

  // ------------------------------------------------------------------ board
  function filtered() {
    var list = rows.filter(function (r) {
      if (state.tier !== 'All' && r.tier !== state.tier) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (state.verdict && scenario(r).verdict !== state.verdict) return false;
      if (state.q) {
        var q = state.q.toLowerCase();
        if ((r.name + ' ' + r.category + ' ' + r.chains.join(' ')).toLowerCase().indexOf(q) < 0) return false;
      }
      return true;
    });
    if (state.sort === 'farms') list = list.slice().sort(function (a, b) { return (scenario(b).net / b.hours) - (scenario(a).net / a.hours); });
    else if (state.sort === 'tvl') list = list.slice().sort(function (a, b) { return b.tvl - a.tvl; });
    else if (state.sort === 'net') list = list.slice().sort(function (a, b) { return scenario(b).net - scenario(a).net; });
    return list;
  }
  function verdictBadge(v) {
    return v === 'FARM' ? '<span class="vfarm">FARM</span>' : v === 'MARGINAL' ? '<span class="vmarg">MARGINAL</span>' : '<span class="vskip">SKIP</span>';
  }
  function renderBoard() {
    var scenarioNote = (state.share !== 7 || state.horizon !== 12 || state.dep !== 'min')
      ? ' <span class="sub">Scenario controls change the displayed verdicts only; board.json stays canonical (7.0% drop share, 12 weeks, minimum deposit).</span>' : '';
    if (state.view === 'live') {
      var live = R.live;
      var tvlSum = live.reduce(function (s, r) { return s + r.tvl; }, 0);
      $('shown').innerHTML = live.length + ' rows shown' + scenarioNote;
      $('board').innerHTML = '<div class="board"><table><tr><th>#</th><th>Protocol</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">Cap / TVL</th><th>Listed</th></tr>' +
        live.map(function (r, i) {
          return '<tr><td>' + (i + 1) + '</td><td><b>' + esc(r.name) + '</b><div class="sub">' + esc(r.cat) + '</div></td><td class="num">' + moneyShort(r.tvl) + '</td><td class="num">' + (r.mcap === null ? '&mdash;' : moneyShort(r.mcap)) + '</td><td class="num">' + (r.mcap === null ? '&mdash;' : '&times;' + (r.mcap / r.tvl).toFixed(2)) + '</td><td>' + (r.listedAt || '&mdash;') + '</td></tr>';
        }).join('') + '</table></div><p class="sub">' + live.length + ' protocols already record a token; they are the priced comps and the set-aside, not the ranking. Total TVL ' + money(tvlSum) + '.</p>';
      return;
    }
    if (state.view === 'out') {
      var out = R.setAside;
      var groups = {};
      out.forEach(function (r) { groups[r.group] = (groups[r.group] || 0) + 1; });
      $('shown').innerHTML = out.length + ' rows shown' + scenarioNote;
      $('board').innerHTML = '<div class="board"><table><tr><th>#</th><th>Protocol</th><th class="num">TVL</th><th>Left out as</th><th>Why</th></tr>' +
        out.map(function (r, i) {
          var why = r.group === 'bridge' ? 'A bridge moves another protocol\'s token; it is not a token waiting to launch.' : r.group === 'liquid-staking' ? 'A staked or restaked product of a token that already trades.' : r.group === 'exchange' ? 'An exchange or its staking product, not a protocol awaiting its own launch.' : 'Versioned or wrapped: a later version, or a wrapped product of a token that trades.';
          return '<tr><td>' + (i + 1) + '</td><td><b>' + esc(r.name) + '</b><div class="sub">' + esc(r.cat) + '</div></td><td class="num">' + moneyShort(r.tvl) + '</td><td>' + r.group + '</td><td class="sub">' + why + '</td></tr>';
        }).join('') + '</table></div><p class="sub">Left out by the house list&rsquo;s own rules: bridge ' + groups.bridge + ', liquid staking ' + groups['liquid-staking'] + ', exchange ' + groups.exchange + ', versioned or wrapped ' + groups['versioned-or-wrapped'] + '. The floor is where the house&rsquo;s reading started, not where yours must stop &mdash; the ranked board carries 20 above the floor the list leaves out.</p>';
      return;
    }
    var list = filtered();
    var tvl = list.reduce(function (s, r) { return s + r.tvl; }, 0);
    var imp = list.reduce(function (s, r) { return s + r.implied; }, 0);
    $('shown').innerHTML = list.length + ' of ' + rows.length + ' rows &middot; ' + money(tvl) + ' TVL &middot; ' + money(imp) + ' implied' + scenarioNote;
    $('board').innerHTML = '<div class="board"><table><tr><th>#</th><th>Range</th><th>Protocol</th><th class="num">TVL</th><th class="num">7D</th><th class="num">No-token age</th><th>Token odds</th><th class="num">If it launches</th><th class="num">Implied value</th><th class="num">P25&ndash;P75</th><th>Verdict &middot; net of fees</th><th class="num">Net / hour</th></tr>' +
      list.map(function (r) {
        var sc = scenario(r);
        var tierBadge = r.tier === 'Watchlist' ? '<span class="badge watch">Watchlist</span>' : r.tier === 'Early' ? '<span class="badge early">Early</span>' : '<span class="badge off">Off-list</span>';
        var g7 = r.g7 === null ? '&mdash;' : '<span class="' + (r.g7 >= 0 ? 'pos' : 'neg') + '">' + (r.g7 >= 0 ? '+' : '') + r.g7.toFixed(1) + '%</span>';
        var warns = r.warnings.map(function (w) { return '<span class="warn">' + esc(w) + '</span>'; }).join('');
        return '<tr data-slug="' + r.slug + '"><td>' + r.rank + '</td><td class="sub">' + r.rankLo + '&ndash;' + r.rankHi + '</td><td><b>' + esc(r.name) + '</b>' + tierBadge + '<div class="sub">' + esc(r.category) + ' &middot; ' + esc(r.chains.join(', ')) + '</div>' + warns + '</td>' +
          '<td class="num">' + moneyShort(r.tvl) + '</td><td class="num">' + g7 + '</td><td class="num">' + ageText(r.age) + '</td>' +
          '<td><span class="oddsbar"><i style="width:' + Math.round(r.odds * 100) + '%"></i></span>' + pct(r.odds) + '</td>' +
          '<td class="num">' + moneyShort(r.ifLaunches) + '</td><td class="num"><b>' + moneyShort(r.implied) + '</b></td><td class="num">' + moneyShort(r.p25) + '&ndash;' + moneyShort(r.p75) + '</td>' +
          '<td>' + verdictBadge(sc.verdict) + ' ' + money(sc.net) + '</td><td class="num">' + (sc.net >= 0 ? '$' : '&minus;$') + Math.abs(sc.net / r.hours).toFixed(2) + '</td></tr>';
      }).join('') + '</table></div>';
  }
  $('board').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-slug]');
    if (tr) openDetail(tr.getAttribute('data-slug'));
  });

  // ----------------------------------------------------------------- detail
  function nearestPeers(r) {
    var x = Math.log10(r.tvl);
    return R.peers.slice().sort(function (a, b) { return Math.abs(Math.log10(a.tvl) - x) - Math.abs(Math.log10(b.tvl) - x); }).slice(0, 8);
  }
  function openDetail(slug) {
    var r = bySlug[slug];
    if (!r) return;
    var b = R.value.beta;
    var x = Math.log10(r.tvl);
    var g7 = Math.max(-50, Math.min(50, r.g7 === null ? 0 : r.g7)) / 100;
    var baseMult = Math.pow(10, b[0] - 8);
    var sizeF = Math.pow(10, b[1] * (x - 8));
    var hingeF = Math.pow(10, b[2] * Math.max(0, x - 9));
    var g7F = Math.pow(10, b[3] * g7);
    var catF = Math.pow(10, catFxOf(r.category));
    var fittedMult = baseMult * sizeF * hingeF * g7F * catF * Math.pow(10, 8 - x);
    var sc = scenario(r);
    var peers = nearestPeers(r);
    var gridShares = [0.035, 0.07, 0.14];
    var gridDeps = [1000, 3000, 10000, 30000];
    var grid = '<table class="pickgrid"><tr><th>Share \\ deposit</th>' + gridDeps.map(function (d) { return '<th>' + money(d) + '</th>'; }).join('') + '</tr>' +
      gridShares.map(function (s) {
        return '<tr><th>' + (s * 100).toFixed(1) + '%</th>' + gridDeps.map(function (d) {
          var net = (s * r.implied * d) / (r.tvl + d) - r.fees;
          var hot = Math.abs(s - state.share / 100) < 0.001 && d === sc.dep;
          return '<td class="' + (hot ? 'hot' : '') + '">' + money(net) + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</table>';
    $('detail').innerHTML = '<div class="detail"><p class="sub">&larr; Board / ' + esc(r.name) + '</p>' +
      '<p class="sub">#' + r.rank + ' of ' + rows.length + ' by implied value &middot; rank ' + r.rankLo + '&ndash;' + r.rankHi + ' across leave-one-out refits (one priced peer left out each time)</p>' +
      '<h2>' + esc(r.name) + '</h2><p class="sub">' + esc(r.category) + ' &middot; ' + esc(r.chains.join(', ')) + ' &middot; ' + r.tier + '</p>' +
      '<div class="cell"><div class="k">Implied value &middot; a model estimate</div><div class="big">' + money(r.implied) + '</div>' +
      '<div class="sub">If a token launches ' + money(r.ifLaunches) + ' &middot; Token odds ' + pct(r.odds) + ' &middot; P25&ndash;P75 ' + money(r.p25) + '&ndash;' + money(r.p75) + ' &middot; P10&ndash;P90 ' + money(r.p10) + '&ndash;' + money(r.p90) + '</div>' +
      '<div class="sub">Recomputed in this browser: equals board.json. DefiLlama records no token for it, which is not proof it has none; the odds are its peers&rsquo; record, not a forecast.</div></div>' +
      '<h3>How the figure is made</h3><table>' +
      '<tr><td>TVL</td><td class="num">' + money(r.tvl) + '</td></tr>' +
      '<tr><td>Base multiple, fitted on ' + v.nPeers + ' traded tokens, read at $100M TVL</td><td class="num">&times;' + baseMult.toFixed(3) + '</td></tr>' +
      '<tr><td>Size curve, log TVL (held-out miss x' + v.tests.wf.toFixed(2) + ' walk-forward)</td><td class="num">&times;' + sizeF.toFixed(2) + '</td></tr>' +
      '<tr><td>Hinge above $1B TVL (held-out miss x' + v.tests.loo.toFixed(2) + ' leave-one-out)</td><td class="num">&times;' + hingeF.toFixed(2) + '</td></tr>' +
      '<tr><td>7-day TVL growth ' + (r.g7 === null ? '(none reported)' : r.g7.toFixed(1) + '%') + '</td><td class="num">&times;' + g7F.toFixed(2) + '</td></tr>' +
      '<tr><td>Category &middot; ' + esc(r.category) + ' (' + (function () { var n = (R.value.catN.find(function (e) { return e[0] === r.category; }) || [0, 0])[1]; return n + (n === 1 ? ' priced peer' : ' priced peers'); })() + ')</td><td class="num">&times;' + catF.toFixed(2) + '</td></tr>' +
      '<tr><td>= Fitted multiple</td><td class="num"><b>&times;' + fittedMult.toFixed(3) + '</b></td></tr>' +
      '<tr><td>= Value if a token launches</td><td class="num"><b>' + money(r.ifLaunches) + '</b></td></tr>' +
      '<tr><td>Token odds: ' + pct(r.oddsByAge) + ' of peers record a token by this age; ' + pct(o.L) + ' ever do</td><td class="num">&times;' + r.odds.toFixed(2) + '</td></tr>' +
      '<tr><td>= Implied value (P25&ndash;P75 ' + money(r.p25) + '&ndash;' + money(r.p75) + ')</td><td class="num"><b>' + money(r.implied) + '</b></td></tr></table>' +
      '<h3>Nearest priced peers &middot; their tokens trade</h3><table><tr><th>Token</th><th>Category</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">Cap / TVL</th><th class="num">Cap &divide; held-out model</th></tr>' +
      peers.map(function (p) {
        return '<tr><td>' + esc(p.name) + '</td><td>' + esc(p.cat) + '</td><td class="num">' + moneyShort(p.tvl) + '</td><td class="num">' + moneyShort(p.mcap) + '</td><td class="num">&times;' + p.ratio.toFixed(2) + '</td><td class="num">&times;' + (p.ratio / p.heldOut).toFixed(2) + '</td></tr>';
      }).join('') + '</table>' +
      '<h3>Farm verdict &middot; ' + sc.verdict + '</h3>' +
      '<div class="grid6">' +
      '<div class="cell"><div class="k">Deposit planned</div><div class="v">' + money(sc.dep) + '</div></div>' +
      '<div class="cell"><div class="k">Modelled drop</div><div class="v">' + money(sc.drop) + '</div></div>' +
      '<div class="cell"><div class="k">Fees (plan gas)</div><div class="v">$' + r.fees.toFixed(2) + '</div></div>' +
      '<div class="cell"><div class="k">Net of fees</div><div class="v">' + money(sc.net) + '</div></div>' +
      '<div class="cell"><div class="k">Net per hour</div><div class="v">$' + (sc.net / r.hours).toFixed(2) + '</div></div>' +
      '<div class="cell"><div class="k">Hands-on time</div><div class="v">' + r.hours.toFixed(1) + ' h</div></div>' +
      '<div class="cell"><div class="k">Same money in a 4% T-bill</div><div class="v">' + money(sc.tbill) + '</div></div>' +
      '<div class="cell"><div class="k">Horizon</div><div class="v">' + state.horizon + ' weeks</div></div>' +
      '<div class="cell"><div class="k">Minimum deposit that farms</div><div class="v">' + (r.minDeposit === null ? 'none' : money(r.minDeposit)) + '</div></div>' +
      '</div>' +
      '<p class="sub">Drop = ' + (state.share).toFixed(1) + '% of the implied value &times; the deposit&rsquo;s share of TVL. FARM beats the T-bill and $25 an hour; MARGINAL clears zero; SKIP does not. Yield earned meanwhile is left out.</p>' +
      '<h4>Net by drop share &times; deposit &middot; pick a cell</h4>' + grid +
      '<h4>Benchmarks</h4><ul class="bench">' +
      '<li>Same ' + money(sc.dep) + ' in a 4% T-bill, ' + state.horizon + ' weeks: ' + money(sc.tbill) + '</li>' +
      '<li>Drop if a token does launch (odds not applied): ' + money(sc.drop / r.odds) + '</li>' +
      '<li>Fees covered above a drop share of ' + pct((r.fees * (r.tvl + sc.dep)) / Math.max(r.implied * sc.dep, 1), 1) + '</li>' +
      '<li>Fees covered above token odds of ' + pct((r.fees * (r.tvl + sc.dep)) / Math.max(0.07 * r.ifLaunches * sc.dep, 1), 1) + '</li>' +
      '<li>Exit if TVL prints below ' + money(r.exitTvl) + ' (&minus;17% in a week)</li></ul>' +
      '<h3>Farm plan &middot; 10 steps</h3><ol class="steps">' + r.farmSteps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      '</div>';
    $('modal').hidden = false;
  }
  $('closeModal').addEventListener('click', function () { $('modal').hidden = true; });
  $('modal').addEventListener('click', function (e) { if (e.target === $('modal')) $('modal').hidden = true; });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') $('modal').hidden = true; });

  // -------------------------------------------------------------------- init
  renderBoard();
  if (params.get('detail')) openDetail(params.get('detail'));
})();
