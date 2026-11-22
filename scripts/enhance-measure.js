#!/usr/bin/env node
// The evidence an enhancement pass starts from, as one JSON document.
//
//   node scripts/enhance-measure.js                  # whole repo, last 90 days of origin/<base>
//   node scripts/enhance-measure.js --since 365      # a quiet repo: widen the window
//   node scripts/enhance-measure.js --scope services/github-review
//   node scripts/enhance-measure.js --ref HEAD --no-prs
//
// `enhance-repo` reads this instead of having every agent re-derive it with
// `git log` pipelines: churn, fix density and co-change are deterministic, and
// paying an agent to compute them in every repo is the largest avoidable cost of
// a pass. The output also carries what triage needs to cut the repo into units —
// the plan backlog by title, the repo's `## Approval` and `## Enhance` sections,
// its hard stops, and size signals for deciding whether to fan out.
//
// Read-only: it never fetches, writes, or asks `gh` to write. Run `git fetch`
// first if `origin/<base>` should be current.

'use strict';

const { execFileSync } = require('node:child_process');

function repoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function tryGit(root, args) {
  try {
    // Probes that may fail (a missing file, an unset origin/HEAD): keep stderr quiet.
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- classification

const FIX_RE = /\b(fix(e[sd])?|revert(s|ed)?|hotfix|crash(es|ed)?|broke|broken|regress(ion|ed)?)\b/i;
const CONVENTIONAL_RE = /^[a-z]+(\([^)]*\))?!?: /;

const NOISE_RES = [
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|uv\.lock|poetry\.lock|Cargo\.lock|Gemfile\.lock|go\.sum|composer\.lock)$/,
  /(^|\/)_plans-map\.md$/,
  /(^|\/)(dist|build|out|coverage|node_modules|\.next|\.astro)\//,
  /\.(min\.js|map|snap)$/,
  /\.(png|jpe?g|gif|webp|svg|ico|pdf|mp4|mov|mp3|wav|woff2?|ttf|zip|gz)$/i,
  // Office documents and data logs: their churn is drafting or capture, not code.
  /\.(docx?|xlsx?|pptx?|odt|ods|epub|jsonl)$/i,
  // Shared resources every feature touches: they co-change with everything,
  // so they are no evidence of a leaking seam.
  /(^|\/)(locales?|i18n|lang|strings)\/[^/]+\.(json|ya?ml|po)$/,
  /(^|\/)strings\.[a-z-]+\.json$/,
];
const PROSE_RE = /\.(md|mdx|txt|rst)$/i;
const TEST_RES = [
  /(^|\/)(tests?|__tests__|spec|e2e)\//,
  /\.(test|spec|vitest)\.[a-z]+$/,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.(py|go)$/,
];

const isFix = (subject) => FIX_RE.test(subject);
const isNoise = (p) => NOISE_RES.some((re) => re.test(p));
const isProse = (p) => PROSE_RE.test(p);
const isTest = (p) => TEST_RES.some((re) => re.test(p));
/** A file whose churn says something about the code: not noise, not prose, not a test. */
const isSource = (p) => !isNoise(p) && !isProse(p) && !isTest(p);

/** The module a path belongs to: its first two directories (`services/github-review`). */
function moduleOf(p) {
  const dirs = p.split('/').slice(0, -1);
  return dirs.length ? dirs.slice(0, 2).join('/') : '.';
}

// ---------------------------------------------------------------- history

/**
 * Parse `git log --format=%x01%h%x1f%s --name-status -M`.
 * Returns commits newest first, with every path rewritten to its newest name, so a
 * renamed file's history counts as one file.
 */
function parseLog(log) {
  const commits = [];
  for (const chunk of log.split('\x01').slice(1)) {
    const [head, ...lines] = chunk.split('\n');
    const [sha, subject = ''] = head.split('\x1f');
    const files = [];
    const renames = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      const status = parts[0];
      if (status.startsWith('R') && parts.length >= 3) {
        renames.push([parts[1], parts[2]]);
        files.push(parts[2]);
      } else if (parts.length >= 2) {
        files.push(parts[parts.length - 1]);
      }
    }
    commits.push({ sha, subject, files, renames });
  }
  // Walk oldest → newest is not needed: newest first, a rename seen earlier in the
  // walk is a later rename, so resolve chains through the map as we go.
  const newest = new Map();
  const resolve = (p) => {
    const seen = new Set();
    while (newest.has(p) && !seen.has(p)) {
      seen.add(p);
      p = newest.get(p);
    }
    return p;
  };
  for (const c of commits) {
    c.files = [...new Set(c.files.map(resolve))];
    for (const [from, to] of c.renames) newest.set(from, resolve(to));
  }
  for (const c of commits) delete c.renames;
  return commits;
}

function countBy(commits, pick) {
  const counts = new Map();
  for (const c of commits) for (const f of c.files) if (pick(f)) counts.set(f, (counts.get(f) || 0) + 1);
  return counts;
}

/** Files that land in the same commits as `file`, with whether each sits in another module. */
function coChange(commits, file, keep, limit = 8) {
  const partners = new Map();
  for (const c of commits) {
    if (!c.files.includes(file)) continue;
    for (const f of c.files) if (f !== file && keep(f)) partners.set(f, (partners.get(f) || 0) + 1);
  }
  return [...partners]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([path, n]) => ({ path, n, crossModule: moduleOf(path) !== moduleOf(file) }));
}

// ---------------------------------------------------------------- tested by import

// "Tested" means a test file imports the module, not that a test is named after it: a
// name match called cultuvilla/app's `municipalityService` untested while four suites
// import it. A module a test only mocks is not tested by that test; a script a test runs
// by its file name is tested by it.

const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '.astro'];
const CODE_RE = /\.(tsx?|jsx?|mjs|cjs|mts|cts|vue|svelte|astro|py)$/;
const NOT_A_MODULE_RE = /(\.d\.ts$|(^|\/)[^/]*\.config\.[a-z]+$|(^|\/)(conftest|setup|manage)\.py$|(^|\/)__init__\.py$)/;

/** A source file a test could import: code in JS/TS or Python, not config or typings. */
const isImportable = (p) => isSource(p) && CODE_RE.test(p) && !NOT_A_MODULE_RE.test(p);

/** Specifiers a JS/TS test imports, and the ones it mocks. */
function jsImports(text) {
  const imports = new Set();
  const mocks = new Set();
  const importRe = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\brequireActual\s*\(\s*|\bimportActual\s*\(\s*)['"]([^'"\n]+)['"]/g;
  const mockRe = /\b(?:jest|vi)\.(?:mock|doMock)\s*\(\s*['"]([^'"\n]+)['"]/g;
  for (const m of text.matchAll(importRe)) imports.add(m[1]);
  for (const m of text.matchAll(mockRe)) mocks.add(m[1]);
  return { imports, mocks };
}

/** Dotted modules a Python test imports, relative ones as `.x` / `..x`. */
function pyImports(text) {
  const mods = new Set();
  for (const m of text.matchAll(/^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(?:\(([^)]*)\)|([\w \t,]+))/gm)) {
    mods.add(m[1]);
    for (const name of (m[2] ?? m[3]).split(',').map((n) => n.trim().split(/\s+/)[0]).filter(Boolean)) {
      mods.add(m[1].endsWith('.') ? m[1] + name : `${m[1]}.${name}`);
    }
  }
  for (const m of text.matchAll(/^[ \t]*import[ \t]+([\w.]+(?:[ \t]*,[ \t]*[\w.]+)*)/gm)) {
    for (const name of m[1].split(',')) mods.add(name.trim());
  }
  return mods;
}

/** JSON with comments and trailing commas, as tsconfig allows; null when unreadable. */
function looseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text.replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str || '').replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return null;
  }
}

/**
 * How bare specifiers map to paths in this repo: workspace package names
 * (`@scope/shared/x` → `packages/shared/{,src/}x`) and tsconfig `paths` aliases.
 * Returns [prefix, [dir, ...]] pairs, longest prefix first.
 */
function aliasesOf(tracked, read) {
  const pairs = [];
  for (const p of tracked) {
    const base = p.split('/').pop();
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    if (base === 'package.json' && dir && !/node_modules\//.test(p)) {
      const name = (looseJson(read(p)) || {}).name;
      if (name) pairs.push([name + '/', [dir + '/', dir + '/src/']], [name, [dir + '/index', dir + '/src/index']]);
    } else if (/^tsconfig[\w.]*\.json$/.test(base)) {
      const opts = (looseJson(read(p)) || {}).compilerOptions || {};
      const root = [dir, opts.baseUrl && opts.baseUrl !== '.' ? opts.baseUrl.replace(/^\.\//, '') : ''].filter(Boolean).join('/');
      for (const [key, targets] of Object.entries(opts.paths || {})) {
        const dirs = (targets || []).map((t) => [root, t.replace(/^\.\//, '')].filter(Boolean).join('/').replace(/\*.*$/, ''));
        pairs.push([key.replace(/\*.*$/, ''), dirs]);
      }
    }
  }
  return pairs.filter(([k]) => k).sort((a, b) => b[0].length - a[0].length);
}

function normalize(p) {
  const out = [];
  for (const part of p.split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}

/** The tracked file a JS/TS specifier from `from` lands on, or null. */
function resolveJs(spec, from, exists, aliases) {
  let bases = [];
  if (spec.startsWith('.')) bases = [normalize(`${from.slice(0, from.lastIndexOf('/') + 1)}${spec}`)];
  else if (spec.startsWith('/')) bases = [normalize(spec)];
  else {
    for (const [prefix, dirs] of aliases) {
      if (spec === prefix || spec.startsWith(prefix)) {
        bases = dirs.map((d) => normalize(d + spec.slice(prefix.length)));
        break;
      }
    }
  }
  for (const b of bases) {
    const stem = b.replace(/\.(js|jsx|mjs|cjs)$/, '');
    for (const c of [b, ...JS_EXTS.map((e) => stem + e), ...JS_EXTS.map((e) => `${b}/index${e}`)]) if (exists.has(c)) return c;
  }
  return null;
}

/**
 * Source modules no test imports. `read(path)` returns a file's text at the measured ref.
 * Returns { tested: Set, importable: [...] }.
 */
function testedByImport(tracked, testFiles, read) {
  const exists = new Set(tracked);
  const aliases = aliasesOf(tracked, read);
  const pyFiles = tracked.filter((p) => p.endsWith('.py'));
  const pyBySuffix = (dotted) => {
    const rel = dotted.replace(/\./g, '/');
    return pyFiles.filter((p) => p === `${rel}.py` || p.endsWith(`/${rel}.py`) || p === `${rel}/__init__.py` || p.endsWith(`/${rel}/__init__.py`));
  };
  // A script a test runs as a subprocess is named in it as a string: `"clone-all.py"`.
  const scripts = new Map();
  for (const p of tracked.filter(isImportable)) {
    const base = p.split('/').pop();
    if (/^[\w-]{3,}\.(py|m?js|ts)$/.test(base) && !/^index\./.test(base)) scripts.set(base, [...(scripts.get(base) || []), p]);
  }
  const tested = new Set();
  for (const t of testFiles) {
    const text = read(t);
    if (!text) continue;
    for (const m of text.matchAll(/['"`/]([\w-]{3,}\.(?:py|m?js|ts))['"`]/g)) {
      const hits = scripts.get(m[1]) || [];
      if (hits.length === 1) tested.add(hits[0]);
    }
    if (t.endsWith('.py')) {
      const dir = t.split('/').slice(0, -1);
      for (const mod of pyImports(text)) {
        if (mod.startsWith('.')) {
          const ups = mod.match(/^\.+/)[0].length;
          const rest = mod.slice(ups).replace(/\./g, '/');
          const base = dir.slice(0, dir.length - (ups - 1)).concat(rest ? [rest] : []).join('/');
          for (const c of [`${base}.py`, `${base}/__init__.py`]) if (exists.has(c)) tested.add(c);
        } else {
          for (const p of pyBySuffix(mod)) tested.add(p);
        }
      }
    } else if (CODE_RE.test(t)) {
      const { imports, mocks } = jsImports(text);
      const mocked = new Set([...mocks].map((s) => resolveJs(s, t, exists, aliases)).filter(Boolean));
      for (const s of imports) {
        const hit = resolveJs(s, t, exists, aliases);
        if (hit && !mocked.has(hit)) tested.add(hit);
      }
    }
  }
  return { tested, importable: tracked.filter(isImportable) };
}

/** Read many files at one ref through a single `git cat-file --batch`. */
function readMany(root, ref, paths) {
  const out = new Map();
  if (!paths.length) return out;
  const buf = execFileSync('git', ['cat-file', '--batch'], {
    cwd: root,
    input: paths.map((p) => `${ref}:${p}`).join('\n') + '\n',
    maxBuffer: 1024 * 1024 * 1024,
  });
  let i = 0;
  for (const p of paths) {
    const nl = buf.indexOf(10, i);
    const head = buf.slice(i, nl).toString();
    i = nl + 1;
    if (head.endsWith(' missing')) continue;
    const size = Number(head.split(' ')[2]);
    out.set(p, buf.slice(i, i + size).toString('utf8'));
    i += size + 1;
  }
  return out;
}

// ---------------------------------------------------------------- repo docs

/** The body of a `## <name>` section, up to the next `## ` heading. */
function section(markdown, name) {
  const re = new RegExp(`^## ${name}\\b[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm');
  const m = markdown.match(re);
  return m ? m[1].trim() : null;
}

/** Title and v2 block lines of a plan file. */
function planHead(text) {
  const title = (text.match(/^# (.+)$/m) || [])[1] || null;
  const field = (k) => ((text.match(new RegExp(`^\\*\\*${k}:\\*\\*\\s*(.+)$`, 'm')) || [])[1] || null);
  return { title, priority: field('Priority'), gate: field('Gate') };
}

// ---------------------------------------------------------------- size and fan-out

// A repo above any of these is large enough that one agent per unit beats one agent
// per repo: exploring a candidate there costs more than onboarding a fresh agent.
const LARGE = { commits: 120, sourceFiles: 250, hottestLines: 900 };

function sizeSignals({ commits, sourceFiles, hottestLines }) {
  const reasons = [];
  if (commits >= LARGE.commits) reasons.push(`${commits} commits in the window`);
  if (sourceFiles >= LARGE.sourceFiles) reasons.push(`${sourceFiles} source files`);
  if (hottestLines >= LARGE.hottestLines) reasons.push(`a ${hottestLines}-line hot file`);
  return { fanoutEligible: reasons.length > 0, reasons };
}

// ---------------------------------------------------------------- main

function parseArgs(argv) {
  const opts = { since: 90, ref: null, scope: null, top: 25, prs: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--since') opts.since = Number(argv[++i]);
    else if (a === '--ref') opts.ref = argv[++i];
    else if (a === '--scope') opts.scope = argv[++i];
    else if (a === '--top') opts.top = Number(argv[++i]);
    else if (a === '--no-prs') opts.prs = false;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function readAt(root, ref, path) {
  return tryGit(root, ['show', `${ref}:${path}`]);
}

function baseRef(root, explicit) {
  if (explicit) return explicit;
  const land = readAt(root, 'HEAD', '.agents/land.config.json');
  if (land) {
    try {
      const base = JSON.parse(land).baseBranch;
      if (base && tryGit(root, ['rev-parse', '--verify', `origin/${base}`])) return `origin/${base}`;
    } catch {}
  }
  const head = tryGit(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head) return head.trim();
  // Many clones never set origin/HEAD.
  for (const b of ['main', 'master', 'develop']) {
    if (tryGit(root, ['rev-parse', '--verify', '--quiet', `origin/${b}`])) return `origin/${b}`;
  }
  return 'HEAD';
}

function measure(root, opts) {
  const ref = baseRef(root, opts.ref);
  const sha = git(root, ['rev-parse', '--short', ref]).trim();
  const date = git(root, ['log', '-1', '--format=%cs', ref]).trim();
  const tracked = git(root, ['ls-tree', '-r', '--name-only', ref]).split('\n').filter(Boolean);
  const exists = new Set(tracked);
  const inScope = (p) => !opts.scope || p === opts.scope || p.startsWith(opts.scope.replace(/\/$/, '') + '/');

  const logArgs = ['log', ref, `--since=${opts.since}.days`, '--no-merges', '-M', '--name-status', '--format=%x01%h%x1f%s'];
  const commits = parseLog(git(root, logArgs)).map((c) => ({ ...c, files: c.files.filter((f) => exists.has(f)) }));
  const fixCommits = commits.filter((c) => isFix(c.subject));

  const keep = (f) => isSource(f) && inScope(f);
  const churn = countBy(commits, keep);
  const fixes = countBy(fixCommits, keep);
  const testFiles = tracked.filter(isTest);
  const sourceFiles = tracked.filter((f) => isSource(f) && inScope(f));
  const configs = tracked.filter((p) => /(^|\/)(package\.json|tsconfig[\w.]*\.json)$/.test(p) && !/node_modules\//.test(p));
  const texts = readMany(root, ref, [...testFiles, ...configs]);
  const { tested, importable } = testedByImport(tracked, testFiles, (p) => texts.get(p));
  const untested = importable.filter((p) => inScope(p) && !tested.has(p));

  const lines = (f) => {
    const text = readAt(root, ref, f);
    return text == null ? 0 : text.split('\n').length;
  };
  const hot = [...churn]
    .sort((a, b) => b[1] - a[1])
    .slice(0, opts.top * 2)
    .map(([path, n]) => ({ path, churn: n, fixes: fixes.get(path) || 0, lines: lines(path) }))
    .map((f) => ({ ...f, score: f.churn * Math.max(1, Math.log2(f.lines + 1)) * (1 + f.fixes / f.churn) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.top)
    .map((f) => ({
      ...f,
      score: Math.round(f.score),
      tested: isImportable(f.path) ? tested.has(f.path) : null,
      coChange: coChange(commits, f.path, keep),
      fixSubjects: fixCommits.filter((c) => c.files.includes(f.path)).slice(0, 5).map((c) => `${c.sha} ${c.subject}`),
    }));

  const modules = new Map();
  for (const [path, n] of churn) {
    const m = modules.get(moduleOf(path)) || { module: moduleOf(path), churn: 0, fixes: 0, files: 0 };
    m.churn += n;
    m.fixes += fixes.get(path) || 0;
    m.files += 1;
    modules.set(m.module, m);
  }

  const agents = readAt(root, ref, 'AGENTS.md') || '';
  let hardStop = [];
  const land = readAt(root, ref, '.agents/land.config.json');
  if (land) {
    try {
      hardStop = JSON.parse(land).hardStop || [];
    } catch {}
  }

  const docs = (dir) =>
    tracked
      .filter((p) => p.startsWith(dir) && p.endsWith('.md') && !/(README|_plans-map)\.md$/.test(p))
      .map((path) => ({ path, ...planHead(readAt(root, ref, path) || '') }));

  let prs = null;
  if (opts.prs) {
    const out = (() => {
      try {
        return execFileSync('gh', ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,headRefName,files'], {
          cwd: root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        return null;
      }
    })();
    if (out) {
      prs = JSON.parse(out).map((p) => ({
        number: p.number,
        title: p.title,
        branch: p.headRefName,
        files: (p.files || []).map((f) => f.path).slice(0, 60),
      }));
    }
  }

  const conventional = commits.filter((c) => CONVENTIONAL_RE.test(c.subject)).length;
  const codeFiles = sourceFiles.length;
  const proseFiles = tracked.filter(isProse).length;

  return {
    repo: root.split('/').pop(),
    ref,
    sha,
    date,
    window: { days: opts.since, commits: commits.length, fixCommits: fixCommits.length },
    scope: opts.scope,
    commitStyle: {
      conventional: commits.length ? Math.round((100 * conventional) / commits.length) : null,
      sample: commits.slice(0, 5).map((c) => c.subject),
    },
    kindHint: /perimeter/i.test(agents) && proseFiles > codeFiles ? 'record' : codeFiles >= proseFiles ? 'code' : 'record',
    size: {
      trackedFiles: tracked.length,
      sourceFiles: codeFiles,
      proseFiles,
      ...sizeSignals({ commits: commits.length, sourceFiles: codeFiles, hottestLines: Math.max(0, ...hot.map((h) => h.lines)) }),
    },
    tests: {
      testFiles: testFiles.length,
      importable: importable.filter(inScope).length,
      untested: untested.length,
      untestedSample: untested.slice(0, 40),
    },
    hot,
    modules: [...modules.values()].sort((a, b) => b.churn - a.churn).slice(0, 15),
    agents: {
      present: Boolean(agents),
      approval: section(agents, 'Approval'),
      enhance: section(agents, 'Enhance'),
      hardStop,
    },
    backlog: {
      ideas: docs('docs/plans/ideas/'),
      ready: docs('docs/plans/ready/'),
      ongoing: docs('docs/plans/ongoing/'),
      decisions: docs('docs/decisions/').map(({ path, title }) => ({ path, title })),
      incidents: docs('docs/incidents/').map(({ path, title }) => ({ path, title })),
    },
    openPrs: prs,
  };
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  process.stdout.write(JSON.stringify(measure(repoRoot(), opts), null, 2) + '\n');
}

module.exports = { parseLog, isFix, isSource, isTest, isNoise, moduleOf, coChange, jsImports, pyImports, resolveJs, testedByImport, isImportable, section, planHead, sizeSignals, measure };
