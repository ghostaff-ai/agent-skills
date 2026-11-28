---
name: harvest
description: Compare a source repo with a target repo of the same family and file each thing the source learned that the target lacks as a plan in the target — plans, never code. Reads the target's harvest ledger first so a recurring run reports only what is new; inventories both repos, checks each candidate by purpose rather than by name with read-only scouts in parallel by lens, drops domain-specific items, classifies each gap as identical (move to agent-skills, vendor into both) or a pattern (port, adapted) and by the target's `## Approval`, fences the files each port would touch, files the plans, appends the ledger and ends with one ranked table and one decision message. Use when the user says "harvest X into Y", "what does X have that Y lacks", "port what worked in X", "compare these two repos", or on a scheduled harvest run.
---

# Harvest one repo into a sibling

What one repo learned the hard way — a CI check, a gate, a runtime rule, an ops script —
should reach its siblings without someone carrying it by hand. A harvest compares a
**source** with a **target**, and each gap it verifies becomes a plan in the target. It
**files plans, never code**, and both repos stay read-only except the target's plans and
its ledger. The target's own rules win over the source's habits everywhere: its
invariants, its land flow, its approval policy.

```
ledger ──► snapshot ──► inventory ──► scouts by lens ──► verify + classify ──► file ──► report
(what is   SHAs of      source items   GAP / EQUAL /      shape, class,        plans +   table +
 known)    both repos   by purpose     DOMAIN / AHEAD     fence                ledger    1 decision
```

Run it from a session in the **target** (that is the repo it writes to). The source is
read through its path on disk; never edit, commit or push there.

## Repo facts this skill reads — never guess them

| Fact | Where |
|---|---|
| plan location, format and metadata block | the target's `AGENTS.md` and its plans skill (`managing-plans-lifecycle`) |
| what agents may start without asking, and what counts as running cost | the target's `AGENTS.md` `## Approval` (absent → nothing is pre-approved) |
| invariants a port must keep, source dirs, test harness | the target's `AGENTS.md` (`## Enhance` if present), its decision records and domain skills |
| commit format; whether docs-only commits go straight to `<base>` | the target's `AGENTS.md`, `.agents/land.config.json` |
| base branch | `.agents/land.config.json` `baseBranch`, else `origin/HEAD`, else `origin/main` |
| what is already shared, and how a repo vendors it | the agent-skills README; the workspace's vendoring script and convention |
| trailers the plan skills query (`Pre-Approved:`) | only if `review-ideas`/`advance-plans` are wired in the target |

## Arguments

| Argument | Meaning | Default |
|---|---|---|
| `<source>` | path to the source repo | required |
| an area (`ci`, `functions/`, …) | **scoped**: inventory only there | the whole source |
| `--lens <name>[,…]` | only these lenses (§3) | all three |
| `--dry-run` | write plans and ledger to a scratch dir, commit nothing | off |

## 1. Ledger first

The ledger is `docs/harvest/<source-name>.md` in the target, one per source. It is what
makes a recurring run cheap: an item it already settled is not reported again.

```markdown
# Harvest from <source-name>

Last run: <date> · source <sha> · target <sha>

| Item (source path) | Verdict | Where | Date | Reason |
|---|---|---|---|---|
| scripts/check-foo.js | filed | docs/plans/ideas/harvest-foo.md | 2026-11-27 | |
| docs/decisions/bar.md | rejected | — | 2026-11-27 | domain: billing only the source has |
| .agents/skills/baz | equal | scripts/qux.mjs | 2026-11-27 | same behaviour under another name |
| scripts/zap.sh | later | — | 2026-11-27 | needs a BigQuery export the target lacks |
```

Verdicts: `filed` (a plan exists), `rejected` (domain-specific, overlaps, or declined by
the user — say which), `equal` (the target already does it; name where), `later` (name
what must change first). Read it before anything else. An item in the ledger is skipped
**unless** its source path changed since the row's date
(`git -C <source> log --since=<date> --oneline -- <path>`) or a `later` row's condition
now holds — then it is re-checked, and reported as *re-opened* with the commits that
moved it. No ledger → a first run; create it.

## 2. Snapshot

Fetch both repos and read at `origin/<base>` of each (`git -C <repo> show`, `git grep
<rev>`), never a working tree someone else is editing. Record both SHAs. On a recurring
run, the source's `git log <last source sha>..origin/<base>` is the list of what moved
since; read it first, it is where new items come from.

## 3. Inventory, then scouts by lens

**Inventory the source** — every place a learned thing can live: `.agents/skills/` (and
any `.claude/skills`), CI workflows, `scripts/`, `docs/decisions/`, `docs/ops/` (or the
runbooks the repo keeps), package scripts, lint configs and custom rules, hooks, test
helpers, and shared helpers of each workspace (backend, app, shared package). One line per
item: path, purpose in a sentence, the commits that shaped it (`git log --format='%h %s'
-- <path>`). Inventory the target the same way, so a scout can match behaviour, not names.

**Scouts run in parallel, one per lens**, read-only (Agent tool, background). A single
pass misses items a differently-lensed pass finds, so split by lens, not by folder:

- **CI and data** — workflows, gates, schema and migration machinery, data audits,
  deploy and release checks.
- **Operations and tooling** — scripts, skills, hooks, agent fleet tooling, runbooks,
  infra hygiene (budgets, cleanup policies), repo automation.
- **App runtime** — client and backend runtime rules: auth, offline, error handling,
  shared helpers, UI primitives, observability.

Inline the whole prompt; a scout knows only what it is handed:

```
You are scout <lens> in harvest <source> → <target>. Both repos are read-only:
NO writes, NO git writes, no installs, builds or tests. Source at <path>@<sha>,
target at <path>@<sha>. Items for your lens: <inventory lines>. Skip these,
already settled: <ledger rows>. Also inventory anything in your lens the list
missed. For each item:
  1. State its PURPOSE in one line — the behaviour, not the file name.
  2. Look for that behaviour in the target by grep on what it does (the check it
     runs, the API it calls, the error it prevents), not by the source's names.
     Candidates have shipped under other names before.
  3. Verdict: GAP (the target lacks it — cite the target paths that prove the
     absence or the weaker copy), EQUAL (cite where the target does it),
     PARTIAL (what the target has, what it misses), DOMAIN (only makes sense
     for the source's product — say why), AHEAD (the target does it better —
     cite both).
Cite path + symbol, never bare line numbers. The source's own prose ("this
fixed X") is a claim; check it in its code and history.
Report one line per item: <source path> | <purpose> | <verdict> | <evidence>.
```

## 4. Verify and classify — the leader

- **Dedupe across lenses**; keep the best-evidenced line.
- **Re-check every GAP and PARTIAL yourself** in the target's code: open the cited paths
  and grep once more for the behaviour. A gap you cannot reproduce is dropped.
- **Drop DOMAIN** items to the ledger as `rejected`, with the reason.
- **Shape.** *Identical*: the same file would work in both with only config values
  different (a check script, a generic skill, a hook) → it moves to agent-skills, values
  into each consumer's config, and both repos vendor it; the plan says so and names the
  source repo's switch-over as a step. *Pattern*: a decision, a gate, a runtime rule that
  must be adapted to the target's invariants → ported in the target. When in doubt it is
  a pattern; an agent-skills move must be procedure-only.
- **Class** by the target's `## Approval`, quoting the line that decides it:
  PRE-APPROVED or NEEDS-YES. Anything that adds a CI job, a deployed function, a schedule
  or a cloud resource is running cost; anything a user sees or does differently needs a
  yes. A mixed item gets a class per part. Unsure → NEEDS-YES.
- **Effort** S / M / L, from the size of the source change and the target's distance.
- **Fence**: list the files each port would touch. Two ports with overlapping fences
  become one plan, or get a stated order, so parallel workers building them never collide.

## 5. File the plans

One plan per gap (or per merged fence), in the target's plan format, in `ideas/` unless
the target's rules place it elsewhere — `review-ideas` and `advance-plans` take it from
there; the harvest never moves a plan to `ready/` and never writes code. Slug
`harvest-<thing>`. Beyond the target's metadata block, every plan carries:

- **Source**: repo, paths, and the commits to port from (`<sha> <subject>`).
- **Gap**: what the target lacks, with the cited target paths.
- **Shape** (identical → agent-skills, or pattern → port) and what to adapt to the
  target's invariants.
- **Class** with the quoted `## Approval` line, and **Fence** (files touched).

Append the ledger in the same change: every item of this run gets a row (`filed`,
`rejected`, `equal`, `later`), and the header gets today's SHAs. Then run the plan
validator if there is one. **One** commit in the target, staged by explicit path, its
subject in the target's format (`docs(plans): harvest from <source> — <n> plans`), the
body one line per plan (`slug · shape · class`), and in the final paragraph a
`Pre-Approved: <slug>` trailer for each PRE-APPROVED plan only where the target wires
that trailer. Docs-only commits go where the target's rules send them (usually straight
to `<base>`); never commit a generated plans map. One repo per commit: nothing is written
to the source or to agent-skills by this run.

## 6. Report

One ranked table — NEEDS-YES and PRE-APPROVED mixed, ranked by value over effort:

```
HARVEST <source>@<sha> → <target>@<sha>   new <n> · re-opened <r> · settled earlier <s>

| # | Item | Gap in the target | Shape | Class | Effort | Plan |
|---|------|-------------------|-------|-------|--------|------|
```

Then **Rejected this run** (one line each, with the reason), **Equal already** (one line
each, with where), and **Target ahead — candidates for the reverse run** (every AHEAD
verdict, with both paths), so the next run can swap source and target.

Then **one decision message**: the ask restated in 2–3 lines, every NEEDS-YES item
numbered with its options, your pick and why, and as its last line
*"Say `go` and I take all my picks."* PRE-APPROVED plans are not asked about — list them
as buildable now. On `go`, write each yes into its plan (`Decided <date> (user)`) in one
commit and say where `review-ideas`/`advance-plans` will find it.

**Unattended** (a scheduled run): ask nothing, file and commit as above, and send the
report where the caller says. Nothing new and nothing re-opened → one line, and only the
ledger header is updated.

## Common mistakes

| Mistake | Instead |
|---|---|
| Matching by file name | Match by behaviour; grep the target for what the item does |
| Trusting a scan's GAP | Re-open the cited target paths before filing |
| Re-reporting last run's items | Read the ledger first; re-open only on a source change |
| One scout over everything | One per lens, in parallel |
| Porting a product feature | DOMAIN → rejected in the ledger, with why |
| Copying an identical script into the target | Plan its move to agent-skills and the vendoring of both repos |
| Calling a new CI job or function pre-approved | It is running cost; quote the `## Approval` line |
| Writing code or editing the source | Plans and the ledger in the target only |
| Two plans touching the same files, unordered | Merge their fences into one plan, or state the order |
| Forgetting the reverse direction | List every AHEAD item for the next run |
