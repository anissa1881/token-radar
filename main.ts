// Token Radar's program (Node 22, standard library only).
//
// It reads the sealed snapshot, scores every rankable pre-token protocol with the model in
// lib/model.ts, and writes the entry's outputs: board.json and data.js, the dashboard and the
// screenshots copied in, and dossier.json from the vendored make.fun library. The program runs
// twice in grading and both runs must write the same bytes, so nothing here reads the clock, a
// random source or the network: the only input is the snapshot file.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The dossier text cap, and the screenshot caps the gate enforces. */
const TEXT_MAX_BYTES = 65_536;
const SHOT_MAX_COUNT = 4;
const SHOT_MAX_BYTES = 524_288;
const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** One --flag <value> (or --flag=value) from the arguments, else the fallback. */
function flag(name: string, fallback: string): string {
  const argv = process.argv;
  const at = argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1]!;
  const joined = argv.find((a) => a.startsWith(`--${name}=`));
  return joined === undefined ? fallback : joined.slice(name.length + 3);
}

/** Fail with a message on stderr and a non-zero exit. */
function fail(message: string): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(1);
}

const inputArg = flag('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  fail(`no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input`);
}
const outDir = flag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) fail(`the model wrote a board the gate refuses: ${issue}`);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(radar));

/** Copy a directory's regular files into `to`, skipping dot-names, and return what was copied. */
function copyDir(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const dashFiles = copyDir(join(here, 'dashboard'), join(outDir, 'dashboard'));
if (dashFiles.length < 3 || !dashFiles.includes('index.html')) {
  fail(`dashboard/ is missing files: found ${dashFiles.join(', ') || 'none'}, need index.html plus a stylesheet and a script`);
}
const shots = copyDir(join(here, 'screenshots'), join(outDir, 'screenshots'));
if (shots.length < 3) {
  fail(`screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view`);
}
if (shots.length > SHOT_MAX_COUNT) fail(`screenshots/ holds ${shots.length} images: at most ${SHOT_MAX_COUNT}`);
for (const name of shots) {
  if (!FILE_NAME.test(name)) fail(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`);
  const size = statSync(join(outDir, 'screenshots', name)).size;
  if (size > SHOT_MAX_BYTES) fail(`screenshots/${name} is ${size} bytes, over the ${SHOT_MAX_BYTES} cap`);
}

// The dossier is written last: the scorer rebuilds it from this output and compares bytes.
const dossierPath = join(outDir, 'dossier.json');
writeFileSync(
  dossierPath,
  buildDossier(outDir, {
    text_max_bytes: TEXT_MAX_BYTES,
    screenshots: { max: SHOT_MAX_COUNT, max_bytes: SHOT_MAX_BYTES },
    dashboard: { max_files: 400, max_bytes: 4_194_304 },
  }),
);
// The dossier embeds the screenshots, so its own cap is the binding one: the site rejects
// anything over 1.5 MiB, and three 512 KiB shots would already break it.
const dossierBytes = statSync(dossierPath).size;
if (dossierBytes > 1_500_000) {
  fail(`dossier.json is ${dossierBytes} bytes: over the 1.5 MiB cap — shrink the screenshots`);
}

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live shown, ${radar.set_aside_size} set aside)\n` +
    `token radar: wrote ${join(outDir, 'board.json')}, ${join(outDir, 'data.js')}, ${join(outDir, 'dashboard')} (${dashFiles.length} files), ${join(outDir, 'screenshots')} (${shots.length} images) and ${dossierPath} (${dossierBytes} bytes)\n` +
    board.slice(0, 5).map((r) => `  #${r.rank} ${r.slug} — implied $${r.implied_value_usd.toLocaleString('en-US')}`).join('\n') + '\n',
);
