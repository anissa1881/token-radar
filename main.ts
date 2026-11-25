// Token Radar, model radar-4.
//
// Reads the sealed snapshot, fits the value and odds models fresh, scores
// every clean pre-token protocol, and writes the ranked board, the
// dashboard's data, and the dossier the judge reads.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|dir>
//
// The snapshot resolves from MAKEFUN_INPUT_DIR (default /input, the sealed
// mount the grader provides) and never from the working directory, so the
// grader may run it from anywhere. Repo files resolve from this file's
// directory. Outputs go to MAKEFUN_OUTPUT_DIR (fallback /output, or --output).
// (Do not look for the snapshot under the repo: the grader mounts it at
// /input, and the repo carries no input/ directory.)

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRadar, boardIssue, dataScript, fitOddsModel, fitValueModel, MODEL_VERSION, parseSnapshot, sha8Hex } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = dirname(fileURLToPath(import.meta.url));

function flagValue(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && i + 1 < args.length) return args[i + 1]!;
    if (args[i]!.startsWith(`--${name}=`)) return args[i]!.slice(name.length + 3);
  }
  return fallback;
}

const inputGiven = flagValue('input', process.env.MAKEFUN_INPUT_DIR ?? '/input');
const inputFile = inputGiven.endsWith('.json') ? inputGiven : join(inputGiven, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile} (pass --input <snapshot.json|directory>)\n`);
  process.exit(2);
}
const outDir = flagValue('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const wl = new Set(snapshot.watchlist);
const peers = snapshot.protocols
  .filter((p) => p.hasToken && p.mcap !== null && p.mcap > 0 && p.tvl > 0 && p.listedAt !== null)
  .map((p) => ({
    slug: p.slug,
    cat: p.cat,
    x: Math.log10(p.tvl),
    y: Math.log10(p.mcap!),
    g7: p.g7 ?? 0,
    age: p.age ?? 1.5,
    listed: p.listedAt!,
  }));
const value = fitValueModel(peers);
const odds = fitOddsModel(
  snapshot.protocols.map((p) => ({ age: p.age, y: p.hasToken ? 1 : 0, cat: p.cat, tvl: p.tvl, g7: p.g7 ?? 0, chains: p.chains.length })),
);
const mainSha8 = sha8Hex(readFileSync(join(here, 'main.ts')));
const radar = buildRadar({ snapshot, value, odds, mainSha8 });
const issue = boardIssue(radar.rows, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the board fails the gate: ${issue}\n`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: radar.rows.map((r) => ({ slug: r.slug, name: r.name, rank: r.rank, implied_value_usd: r.implied, farm_steps: r.farmSteps })) })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(radar));

function copyDir(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const names: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    names.push(name);
  }
  return names;
}

copyDir(join(here, 'dashboard'), join(outDir, 'dashboard'));
const shots = copyDir(join(here, 'screenshots'), join(outDir, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} images: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: bad image name\n`);
    process.exit(1);
  }
}
writeFileSync(
  join(outDir, 'dossier.json'),
  buildDossier(outDir, { text_max_bytes: 65_536, screenshots: { max: 4, max_bytes: 524_288 }, dashboard: { max_files: 400, max_bytes: 4_194_304 } }),
);

process.stdout.write(
  `token radar ${MODEL_VERSION}: ${snapshot.protocols.length} protocols, ${wl.size} on the watchlist, ${radar.rows.length} rows ranked (${radar.accounting.ranked.early} early, ${radar.accounting.ranked.offList} off-list)\n` +
    `token radar ${MODEL_VERSION}: value miss LOO x${value.tests.loo.toFixed(2)} walk-forward x${value.tests.wf.toFixed(2)} ten-fold x${value.tests.ten.toFixed(2)} older-to-newer x${value.tests.oldNew.toFixed(2)}\n` +
    `token radar ${MODEL_VERSION}: odds L=${odds.L} k=${odds.k} survival Brier ${odds.brierSurv.toFixed(3)} logistic Brier ${odds.brierLogit.toFixed(3)}\n` +
    `token radar ${MODEL_VERSION}: ${radar.nFarm} FARM / ${radar.nMarginal} MARGINAL / ${radar.nSkip} SKIP, total implied $${radar.totalImplied.toLocaleString('en-US')}\n` +
    `token radar ${MODEL_VERSION}: wrote board.json, data.js, dashboard, ${shots.length} screenshots and dossier.json to ${outDir}\n`,
);
