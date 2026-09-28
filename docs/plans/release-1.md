# Release 1 (0.1.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship ship-kit 0.1.0: the plugin skeleton with its CI gates, the declared superpowers dependency verified on a fresh install, the release-1 practice skills (design review, PR-sequence planning, proving tests can fail, watching PR checks, mining defect shapes), and the libraries release 2 builds on (glob, stamp, state-marker codec).

**Architecture:** Layer 0 is Node standard-library scripts under `scripts/`, each covered by `node --test`; layer 1 and 2 are skills under `skills/<name>/SKILL.md` that name those scripts through `${CLAUDE_PLUGIN_ROOT}` and run them through their interpreter. Repository gates (ASCII, skill naming and size, pressure-test records, plugin validation, component inventory) are ordinary `node --test` suites run by a new `ci.yml`. Nothing in release 1 commits, pushes, merges or installs files into another repository.

**Tech Stack:** Node 22 (standard library only, ESM `.mjs`), bash (watchers), GitHub CLI `gh`, Claude Code CLI 2.1.284 (`claude plugin validate`, `claude plugin details`, `claude -p`), actionlint 1.7.12, gitleaks 8.30.1.

**Spec:** `docs/design/ship-kit-design.md` (sections 4, 8.2, 9, 16.2, 17, 18, 19.2, 20.4, 20.5, 21, 22.1, 22.8, 22.9). Binding rules: `CLAUDE.md`. Executors read both.

## Global Constraints

- Node standard library only; no `package.json`, no `npm install` (design 3: plugin installs run none).
- Every script is invoked through its interpreter (`node ...`, `bash ...`); scripts keep their executable bit (CLAUDE.md, Hooks and scripts).
- No top-level `bin/` (CLAUDE.md, Hooks and scripts).
- ASCII only in every tracked file: bytes 0x20-0x7E, tab and newline; no em dashes, no curly quotes, no CR (design 21.2; enforced by `tests/ascii.test.mjs` from Task 1). Verbatim model output recorded in pressure-test files is transcribed with every non-ASCII character replaced by its ASCII equivalent (em dash to `--`, curly quotes to straight quotes, arrow to `->`).
- Generic content only: no adopting-repo names, paths, incidents, service names or ticket numbers (CLAUDE.md, Repo rules).
- No changelogs or revision history in any document.
- Skills: SKILL.md under 500 lines; description plus `when_to_use` under 1,536 characters; description starts `Use when ` and states triggering conditions only, never the steps; gerund names except the command skills `setup`, `develop`, `ship`, `ci-watch`, `merge`; cross-reference other skills by name only, never with `@`; reference files one level deep; aim for a body under 500 words (CLAUDE.md, Skills).
- Every skill ships its pressure-test record `tests/skills/<skill>/{scenario,baseline,result}.md` (design 21.5), produced by the method in "Pressure-test method" below.
- Every test named for a guard is proven able to fail: the PR body names the mutation applied (one production line) and quotes the red run (design 21.1).
- Commits: stage files by name (never `git add .` or `-A`), never `--amend`, never `--no-verify`. Every commit ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01ABJKWDasJMo4WxwPsifA8W
  ```
- Each task is one branch `r1/<task-slug>` from current `main`, one PR to `main`. Merge when its CI is green and review passes; only Task 12 needs owner approval.
- `plugin.json` `version` is bumped only in Task 11; `marketplace.json` never carries a `version` (CLAUDE.md, Manifests and naming).

## Standard verification (every task runs all of these before opening its PR)

```bash
node --test "tests/**/*.test.mjs" "scripts/*.test.mjs"
claude plugin validate --strict .
docker run --rm -v "$PWD:/repo" -w /repo zricethezav/gitleaks:v8.30.1 git . --config .gitleaks.toml --redact
node scripts/check-template-secrets.mjs
```

Expected: the test run ends `fail 0`; validate prints `Validation passed` and exits 0 (from Task 1 on; on `main` at 29b8580 it fails for the missing marketplace description that Task 1 adds); gitleaks reports `no leaks found`; the template check exits 0. Task 1 adds `actionlint .github/workflows/*.yml` to this list for every later task. Tasks in wave 1 other than Task 1 run the first command as `node --test "tests/lib/*.test.mjs" "scripts/*.test.mjs"` if Task 1 has not merged yet, and `claude plugin validate --strict .` is then expected to fail with the marketplace-description warning only.

To check one file for non-ASCII bytes before `tests/ascii.test.mjs` exists or before staging:

```bash
node -e 'const b=require("fs").readFileSync(process.argv[1]);let bad=0;b.forEach((x,i)=>{if(x!==9&&x!==10&&(x<32||x>126)){bad++;console.log("non-ASCII byte 0x"+x.toString(16)+" at offset "+i)}});process.exitCode=bad?1:0' <file>
```

## Pressure-test method (design 21.5; CLAUDE.md, Skills)

Every skill task produces `tests/skills/<skill>/scenario.md`, `baseline.md` and `result.md`. Task 1's `tests/skills/artifacts.test.mjs` fails the build when any is missing or empty.

**scenario.md** holds, in this order: `## Kind` (`discipline` or `output-shaping`); `## Prompt` (the exact text given to the model); `## Pass criteria` (a numbered list, each item checkable by reading the output). A discipline prompt combines at least three pressures (time, sunk cost, authority, exhaustion, social), names real paths in this repository, offers lettered options, and gives no escape to a human ("You cannot ask anyone; choose now"). An output-shaping prompt asks for the artifact the skill shapes.

**RED (baseline.md).** From the task's worktree, with ship-kit not installed (`claude plugin list` shows no `ship-kit`):

```bash
claude -p "$(sed -n '/^## Prompt$/,/^## Pass criteria$/p' tests/skills/<skill>/scenario.md | sed '1d;$d')" > "$SCRATCH/<skill>-red.txt"
```

`$SCRATCH` is the session scratchpad (or `mktemp -d`); never write probe output beside the code. `baseline.md` records the CLI version (`claude --version`), the verbatim output (ASCII-transcribed), each pass criterion marked PASS or FAIL, and, for a discipline skill, a `## Rationalizations` list quoting every excuse the model gave, verbatim.

**GREEN (result.md).** Write the skill addressing exactly the failures in the baseline, then run the same prompt with the plugin loaded:

```bash
claude --plugin-dir "$PWD" -p "<same prompt>" > "$SCRATCH/<skill>-green.txt"
```

`result.md` records the verbatim output and each pass criterion PASS or FAIL. Every criterion must PASS.

**REFACTOR.** For a discipline skill, each new rationalization seen in a GREEN run is added to the skill's rationalization table with its counter, and the run is repeated; `result.md` ends with a `## Loopholes closed` list (one line per addition, or "none observed"). Discipline skills use a prohibition, a rationalization table and a red-flags list; output-shaping skills use a positive recipe and no prohibitions, and have no rationalization table (CLAUDE.md, Skills). A later change to a skill reruns its scenario in the same PR.

## Review Focus

1. A managed file or a state-marker comment arriving with CRLF line endings (a Windows checkout, an API body) must read exactly as its LF form: Task 3 (`a CRLF checkout of a stamped file still reads as current`) and Task 4 (`a CRLF comment body decodes`).
2. A cancelled required check must never read as green: Task 9 (`a cancelled check is reported as FAILED; a skipped one is not`).
3. Paths containing regex metacharacters, brackets, braces or a leading dot must match literally and predictably: Task 2 (`a+b.md`, `docs/(x).md`, `[ab].md`, `{a,b}.md`, `.claude/**` cases).
4. A rate-limit failure partway through pagination, or a listing cut off at its limit, must never produce evidence that looks complete: Task 8 (`main exits 1 and writes nothing when a call fails`; `a PR count equal to --limit prints the truncation warning`).
5. A skill whose frontmatter uses a YAML construct the gates cannot read (a folded `>` description) must fail the gate, not slip past it: Task 1 (`a multi-line description fails loudly`).

## Rulings on points the spec leaves open

Each is decided here and binds the task named.

1. The spec's four release-1 PRs are split into twelve tasks for review size; their content is unchanged. The `plugin.json` bump to 0.1.0 is its own last PR (Task 11) so it is the last PR of the release whichever wave-3 task merges last (design 22: "bumped in the last PR of each release").
2. `claude plugin validate --strict .` at 29b8580 fails on a missing marketplace description; Task 1 adds `metadata.description` to `marketplace.json`.
3. `claude plugin validate --strict .` checks only the marketplace manifest. The plugin is validated with `--json` against `.claude-plugin/plugin.json`, failing on every finding except the root-`CLAUDE.md` warning, which the maintainer manual triggers by design; Task 1 amends CLAUDE.md, Testing and validation, to say so (design D19: no silent departure).
4. `tests/expected-inventory.txt` lists the non-skill categories only; the inventory test compares the loaded skills with the `skills/*/` directories. Skill PRs therefore never edit a shared registry file and can run in parallel waves.
5. The README lists `scripts/lib/` as one row (libraries, never run alone, no network); each entry-point script gets its own row in the PR that adds it.
6. `review/hunt-lists/design-shared.md` (Task 5) cannot point at `skills/mining-defect-shapes/hunt-list-format.md` before that file exists; Task 5 pins the format in `tests/hunt-lists/format.test.mjs`, and Task 10 adds the pointer line and asserts that the format document's example passes the same checker.
7. Shared hunt lists carry no `Instances:` field (design 18.6: no instance text from any repo); repo lists do.
8. The watchers use `node` instead of `jq` (node is already required; jq is not), treat a `cancel` bucket as a failure, print a `FAILED:` line for every merge-commit run that did not end `success`, `skipped` or `neutral`, accept only a lowercase 40-hex SHA, and exit 2 on any non-numeric argument.
9. `collect.mjs` also requires `--out <dir>` (a script cannot know the session scratchpad), refuses a non-empty `--out`, takes `--limit` (default 1000) for the truncation warning, calls `gh api --paginate --slurp`, writes nothing unless every call succeeds, and for the design target keeps only PRs with at least one `design-doc` marker.
10. The state-marker codec accepts exactly the eight keys of design 8.2, writes them in a fixed order so an encode of a decode is byte-identical, allows `mergeBase: null`, requires canonical base64url, caps the payload at 65,536 characters, and reads only an exact first line.
11. `glob.mjs` refuses patterns and paths with a leading `/` or `./` or a trailing `/`, treats dotfiles like any file, and supports no brackets, braces or escapes (all literal).
12. `stamp.mjs` hashes text with CRLF read as LF, supports three comment syntaxes (`hash` `#`, `slash` `//`, `html` `<!-- -->`), and throws on a stamp line whose JSON is invalid rather than reading the file as unmanaged.
13. Skill gates read frontmatter as single-line `key: value` scalars only; a skill directory holds only `SKILL.md` and `.md` reference files, each named in `SKILL.md`.
14. Pressure tests run headless through `claude -p`, RED without `--plugin-dir`, GREEN with it, using lettered-option prompts so no run needs write permissions.
15. `planning-deployable-pr-sequences` names no superpowers skill: cross-plugin invocation by name is unverified (design F14), and the skill stands alone.
16. CI pins the Claude Code CLI to 2.1.284 through npm, actionlint 1.7.12 by checksum, Node 22 (as `secret-scan.yml`); the job's check context is `ci`.
17. Making `ci` and `gitleaks` required on `main`, and the `ship-kit--v*` tag-protection ruleset (design 22.9, PR 1.1 note), are admin actions carried out in Task 12 under the owner's approval.

## File map

| Path | Task | Responsibility |
|---|---|---|
| `.github/workflows/ci.yml` | 1 | unit suites, gates, actionlint |
| `.claude-plugin/marketplace.json` | 1 | adds `metadata.description` |
| `CLAUDE.md` | 1 | the three design-required amendments plus validation, local checks and checklist lines |
| `README.md` | 1, 8, 9 | hook and script inventory, secrets section |
| `tests/helpers/skills.mjs` | 1 | frontmatter subset parser, skill listing |
| `tests/skills/{naming,size,artifacts}.test.mjs` | 1 | skill gates |
| `tests/{ascii,inventory,plugin-validate}.test.mjs`, `tests/expected-inventory.txt` | 1 | repository gates |
| `scripts/lib/glob.mjs`, `tests/lib/glob.test.mjs` | 2 | `*`, `**`, `?` matching |
| `scripts/lib/stamp.mjs`, `tests/lib/stamp.test.mjs` | 3 | managed-file stamps and blocks |
| `scripts/lib/state-marker.mjs`, `tests/lib/state-marker.test.mjs` | 4 | state-marker codec |
| `skills/reviewing-design-documents/{SKILL,pattern-method}.md`, `review/hunt-lists/design-shared.md`, `tests/hunt-lists/{format.mjs,format.test.mjs}` | 5 | design method, 20 shared shapes, list format checker |
| `skills/planning-deployable-pr-sequences/SKILL.md` | 6 | plan recipe |
| `skills/proving-tests-can-fail/SKILL.md` | 7 | mutation discipline |
| `scripts/mining/collect.mjs`, `tests/mining/collect.test.mjs` | 8 | mining evidence collector |
| `scripts/watch/{watch-pr-checks,watch-merge-deploy}.sh`, `tests/watch/*`, `skills/watching-pr-checks/SKILL.md` | 9 | watchers and their skill |
| `skills/mining-defect-shapes/{SKILL,hunt-list-format}.md`, `review/hunt-lists/code-shared.md` | 10 | mining method, list format, shared METHOD |
| `.claude-plugin/plugin.json` | 11 | version 0.1.0 |
| `tests/skills/<skill>/{scenario,baseline,result}.md` | 5, 6, 7, 9, 10 | pressure-test records |

## Waves and dependency order

| Wave | Tasks | Starts when | Why these are parallel |
|---|---|---|---|
| 1 | 1, 2, 3, 4 | now | disjoint files; 2, 3, 4 are libraries no one calls yet |
| 2 | 5, 6, 7, 8 | wave 1 merged | skills need Task 1's gates to run on them; Task 7's scenario uses Task 2's files; Task 8 imports Task 4; only Task 8 edits README |
| 3 | 9, 10 | wave 2 merged | Task 9 edits README after Task 8; Task 10 needs Task 8's script and Task 5's list and checker |
| 4 | 11 | wave 3 merged | the version bump is the release's last PR |
| 5 | 12 | Task 11 merged and the owner approves | tagging and admin rulesets |

Dependencies: 2 -> 7; 4 -> 8 -> 10; 5 -> 10; 1 -> every skill task (5, 6, 7, 9, 10); 8 -> 9 (README); all -> 11 -> 12.

## Models

| Task | Model | Why this tier |
|---|---|---|
| 1 | sonnet | several files, verified content given, but CI bring-up and the live-doc check for the CLAUDE.md amendment need judgment |
| 2 | haiku | transcription of complete, run-verified code and tests plus a named mutation |
| 3 | haiku | same |
| 4 | haiku | same |
| 5 | opus | judgment-heavy design method, 20 shape write-ups, discipline pressure test |
| 6 | sonnet | output-shaping recipe from a given contract; output check is mechanical |
| 7 | opus | discipline skill whose rationalization table must come from observed baseline behavior |
| 8 | haiku | transcription of complete, run-verified code and tests plus README row |
| 9 | haiku | transcription of complete scripts, tests and SKILL.md; output-shaping pressure run is mechanical |
| 10 | opus | judgment-heavy mining method with discipline drop rules and a format document |
| 11 | haiku | single-line manifest edit |
| 12 | sonnet | release checklist items need judgment (generic-content sweep, inventory review) |

---

### Task 1: Repository gates, CI and maintainer-manual amendments

Spec: design 21.1, 21.2, 22.1 PR 1.1, 22.9 (PR 1.1 note), 24.2; rulings R13, R14, R17; fact F8.

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `tests/helpers/skills.mjs`
- Create: `tests/skills/naming.test.mjs`, `tests/skills/size.test.mjs`, `tests/skills/artifacts.test.mjs`
- Create: `tests/ascii.test.mjs`, `tests/inventory.test.mjs`, `tests/plugin-validate.test.mjs`, `tests/expected-inventory.txt`
- Modify: `.claude-plugin/marketplace.json` (add `metadata.description`)
- Modify: `CLAUDE.md` (Skills: naming rule, side-effect rule; Hooks and scripts: plugin-root rule; Secrets: local checks; Testing and validation: validate rule; Pre-release checklist)
- Modify: `README.md` (hook and script inventory, secrets section)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `tests/helpers/skills.mjs` exports `parseFrontmatter(text: string): Record<string, string>` and `listSkills(root: string): {name, dir, files: string[], text: string | null}[]`; `COMMAND_SKILLS` in `tests/skills/naming.test.mjs`; the gates every skill task must pass; the `ci` check context.

**Why safe alone:** adds no user-visible component (the plugin's inventory is unchanged: zero skills, zero hooks); the gates pass vacuously on zero skills and are proven by fixtures; the CLAUDE.md amendments state rules for skills that later tasks add; nothing here names a file that does not exist.

- [ ] **Step 1: Write the skill-listing helper**

`tests/helpers/skills.mjs`:

```js
// Reads the plugin's skills for the repository gates. Frontmatter is a
// deliberately small subset of YAML: `key: value` lines with single-line
// scalar values, optionally quoted. Anything else throws, so a skill that
// uses a construct the gates cannot read fails loudly instead of passing.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** @param {string} text @returns {Record<string, string>} */
export function parseFrontmatter(text) {
  const lines = text.split("\n");
  if (lines[0] !== "---") throw new Error("SKILL.md must start with a --- frontmatter line");
  const end = lines.indexOf("---", 1);
  if (end === -1) throw new Error("frontmatter has no closing --- line");
  const fields = {};
  for (const line of lines.slice(1, end)) {
    if (line.trim() === "") continue;
    const match = line.match(/^([a-z][a-z0-9_-]*):[ ]+(.+)$/);
    if (!match) throw new Error(`unsupported frontmatter line: ${JSON.stringify(line)}`);
    let value = match[2].trim();
    if (/^[>|]/.test(value)) throw new Error(`multi-line value for ${match[1]} is not supported`);
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    if (match[1] in fields) throw new Error(`duplicate frontmatter key: ${match[1]}`);
    fields[match[1]] = value;
  }
  return fields;
}

/**
 * @param {string} root plugin root
 * @returns {{name: string, dir: string, files: string[], text: string}[]}
 */
export function listSkills(root) {
  const skillsDir = join(root, "skills");
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir)
    .filter((name) => statSync(join(skillsDir, name)).isDirectory())
    .sort()
    .map((name) => {
      const dir = join(skillsDir, name);
      const skillFile = join(dir, "SKILL.md");
      return {
        name,
        dir,
        files: readdirSync(dir).sort(),
        text: existsSync(skillFile) ? readFileSync(skillFile, "utf8") : null,
      };
    });
}
```

- [ ] **Step 2: Write the gate tests (each gate is a function in its test file, exercised by fixtures and by one test over this repository)**

`tests/skills/naming.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { listSkills, parseFrontmatter } from "../helpers/skills.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

// The command skills keep imperative names; every other skill is named in
// gerund form (CLAUDE.md, Skills).
export const COMMAND_SKILLS = ["setup", "develop", "ship", "ci-watch", "merge"];

/** @returns {string[]} violations */
export function checkSkillNames(root) {
  const violations = [];
  for (const skill of listSkills(root)) {
    if (skill.text === null) {
      violations.push(`skills/${skill.name}: no SKILL.md`);
      continue;
    }
    let fields;
    try {
      fields = parseFrontmatter(skill.text);
    } catch (error) {
      violations.push(`skills/${skill.name}: ${error.message}`);
      continue;
    }
    if (fields.name !== skill.name) {
      violations.push(`skills/${skill.name}: frontmatter name ${JSON.stringify(fields.name)} differs from its directory`);
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name)) {
      violations.push(`skills/${skill.name}: use lowercase letters, numbers and single hyphens only`);
    }
    const firstWord = skill.name.split("-")[0];
    if (!COMMAND_SKILLS.includes(skill.name) && !firstWord.endsWith("ing")) {
      violations.push(`skills/${skill.name}: not a command skill, so its name must start with a gerund`);
    }
  }
  return violations;
}

function fixture(skills) {
  const root = mkdtempSync(join(tmpdir(), "naming-"));
  for (const [dir, text] of Object.entries(skills)) {
    mkdirSync(join(root, "skills", dir), { recursive: true });
    if (text !== null) writeFileSync(join(root, "skills", dir, "SKILL.md"), text);
  }
  return root;
}

const skillText = (name) => `---\nname: ${name}\ndescription: Use when testing.\n---\n\nBody.\n`;

test("every skill in this repository passes the naming gate", () => {
  assert.deepEqual(checkSkillNames(REPO), []);
});

test("a gerund-named skill and each command skill pass", () => {
  const skills = { "mining-defect-shapes": skillText("mining-defect-shapes") };
  for (const name of COMMAND_SKILLS) skills[name] = skillText(name);
  assert.deepEqual(checkSkillNames(fixture(skills)), []);
});

test("a non-gerund, non-command skill fails", () => {
  assert.equal(checkSkillNames(fixture({ "defect-miner": skillText("defect-miner") })).length, 1);
});

test("a name that only resembles a command skill fails", () => {
  assert.equal(checkSkillNames(fixture({ "ship-it": skillText("ship-it") })).length, 1);
});

test("a frontmatter name that differs from the directory fails", () => {
  assert.equal(checkSkillNames(fixture({ "mining-x": skillText("mining-y") })).length, 1);
});

test("uppercase or underscores fail the character rule", () => {
  for (const name of ["Mining-x", "mining_x-ing"]) {
    const violations = checkSkillNames(fixture({ [name]: skillText(name) }));
    assert.ok(violations.some((v) => v.includes("lowercase letters")), name);
  }
});

test("a skill directory with no SKILL.md fails", () => {
  assert.equal(checkSkillNames(fixture({ "mining-x": null })).length, 1);
});
```

`tests/skills/size.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { listSkills, parseFrontmatter } from "../helpers/skills.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const MAX_LINES = 500;
const MAX_LISTING_CHARS = 1536;

/** @returns {string[]} violations */
export function checkSkillShape(root) {
  const violations = [];
  for (const skill of listSkills(root)) {
    const where = `skills/${skill.name}`;
    if (skill.text === null) continue; // reported by the naming gate
    const lineCount = skill.text.split("\n").length - (skill.text.endsWith("\n") ? 1 : 0);
    if (lineCount >= MAX_LINES) violations.push(`${where}: SKILL.md has ${lineCount} lines (limit: under ${MAX_LINES})`);
    let fields;
    try {
      fields = parseFrontmatter(skill.text);
    } catch (error) {
      violations.push(`${where}: ${error.message}`);
      continue;
    }
    const description = fields.description ?? "";
    if (!description.startsWith("Use when ")) {
      violations.push(`${where}: description must state triggering conditions, starting "Use when "`);
    }
    if (fields["disable-model-invocation"] !== "true") {
      const listing = description.length + (fields.when_to_use ?? "").length;
      if (listing >= MAX_LISTING_CHARS) {
        violations.push(`${where}: description plus when_to_use is ${listing} characters (limit: under ${MAX_LISTING_CHARS})`);
      }
    }
    for (const file of skill.files) {
      if (file === "SKILL.md") continue;
      if (!file.endsWith(".md")) {
        violations.push(`${where}/${file}: a skill directory holds only SKILL.md and .md reference files`);
      } else if (!skill.text.includes(file)) {
        violations.push(`${where}/${file}: not referenced from SKILL.md (references are one level deep)`);
      }
    }
  }
  return violations;
}

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "size-"));
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, "skills", path);
    mkdirSync(join(full, ".."), { recursive: true });
    if (text === "<dir>") mkdirSync(full, { recursive: true });
    else writeFileSync(full, text);
  }
  return root;
}

const skill = (description, body = "Body.\n", extra = "") =>
  `---\nname: mining-x\ndescription: ${description}\n${extra}---\n\n${body}`;

test("every skill in this repository passes the size and description gate", () => {
  assert.deepEqual(checkSkillShape(REPO), []);
});

test("a well-formed skill with a referenced sibling passes", () => {
  const root = fixture({
    "mining-x/SKILL.md": skill("Use when testing.", "See format.md.\n"),
    "mining-x/format.md": "Format.\n",
  });
  assert.deepEqual(checkSkillShape(root), []);
});

test("a SKILL.md of 500 lines fails and one of 499 passes", () => {
  const header = skill("Use when testing.", "");
  const headerLines = header.split("\n").length - 1;
  const body = (n) => "x\n".repeat(n - headerLines);
  assert.equal(checkSkillShape(fixture({ "mining-x/SKILL.md": header + body(500) })).length, 1);
  assert.deepEqual(checkSkillShape(fixture({ "mining-x/SKILL.md": header + body(499) })), []);
});

test("a description that summarizes steps instead of triggers fails", () => {
  assert.equal(checkSkillShape(fixture({ "mining-x/SKILL.md": skill("Collects evidence, then clusters it.") })).length, 1);
});

test("a model-invocable description at 1,536 characters fails; 1,535 passes", () => {
  const text = (n) => `Use when ${"x".repeat(n - 9)}`;
  assert.equal(checkSkillShape(fixture({ "mining-x/SKILL.md": skill(text(1536)) })).length, 1);
  assert.deepEqual(checkSkillShape(fixture({ "mining-x/SKILL.md": skill(text(1535)) })), []);
});

test("when_to_use counts toward the listing cap", () => {
  const root = fixture({
    "mining-x/SKILL.md": skill(`Use when ${"x".repeat(1000)}`, "Body.\n", `when_to_use: ${"y".repeat(600)}\n`),
  });
  assert.equal(checkSkillShape(root).length, 1);
});

test("a disable-model-invocation skill is exempt from the listing cap", () => {
  const root = fixture({
    "mining-x/SKILL.md": skill(`Use when ${"x".repeat(2000)}`, "Body.\n", "disable-model-invocation: true\n"),
  });
  assert.deepEqual(checkSkillShape(root), []);
});

test("a multi-line description fails loudly", () => {
  const root = fixture({ "mining-x/SKILL.md": "---\nname: mining-x\ndescription: >\n  Use when x.\n---\n" });
  assert.equal(checkSkillShape(root).length, 1);
});

test("an unreferenced sibling, a non-md sibling and a nested directory fail", () => {
  const root = fixture({
    "mining-x/SKILL.md": skill("Use when testing."),
    "mining-x/orphan.md": "x\n",
    "mining-x/run.sh": "x\n",
    "mining-x/nested": "<dir>",
  });
  assert.equal(checkSkillShape(root).length, 3);
});
```

`tests/skills/artifacts.test.mjs`:

```js
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { listSkills } from "../helpers/skills.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
export const ARTIFACTS = ["scenario.md", "baseline.md", "result.md"];

/** Every skill carries its pressure-test record (design 21.5). @returns {string[]} */
export function checkSkillArtifacts(root) {
  const violations = [];
  for (const skill of listSkills(root)) {
    for (const file of ARTIFACTS) {
      const path = join(root, "tests", "skills", skill.name, file);
      if (!existsSync(path) || readFileSync(path, "utf8").trim() === "") {
        violations.push(`tests/skills/${skill.name}/${file}: missing or empty`);
      }
    }
  }
  return violations;
}

test("every skill in this repository has its pressure-test record", () => {
  assert.deepEqual(checkSkillArtifacts(REPO), []);
});

test("a skill with a missing or empty artifact fails, one per file", () => {
  const root = mkdtempSync(join(tmpdir(), "artifacts-"));
  mkdirSync(join(root, "skills", "mining-x"), { recursive: true });
  writeFileSync(join(root, "skills", "mining-x", "SKILL.md"), "---\nname: mining-x\n---\n");
  mkdirSync(join(root, "tests", "skills", "mining-x"), { recursive: true });
  writeFileSync(join(root, "tests", "skills", "mining-x", "scenario.md"), "Scenario.\n");
  writeFileSync(join(root, "tests", "skills", "mining-x", "baseline.md"), "  \n");
  assert.deepEqual(checkSkillArtifacts(root), [
    "tests/skills/mining-x/baseline.md: missing or empty",
    "tests/skills/mining-x/result.md: missing or empty",
  ]);
});
```

`tests/ascii.test.mjs`:

```js
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO = fileURLToPath(new URL("..", import.meta.url));

/** @param {Buffer} bytes @returns {{line: number, byte: number}[]} bytes outside printable ASCII, tab and newline */
export function findNonAscii(bytes) {
  const found = [];
  let line = 1;
  for (const byte of bytes) {
    if (byte === 0x0a) {
      line += 1;
      continue;
    }
    if (byte !== 0x09 && (byte < 0x20 || byte > 0x7e)) found.push({ line, byte });
  }
  return found;
}

test("findNonAscii accepts printable ASCII, tab and newline", () => {
  assert.deepEqual(findNonAscii(Buffer.from("a\tb ~\n}\n", "utf8")), []);
});

test("findNonAscii reports an em dash, a carriage return and a NUL by line", () => {
  const emDash = String.fromCharCode(0x2014);
  const found = findNonAscii(Buffer.from(`ok\na ${emDash} b\nc\r\n` + String.fromCharCode(0), "utf8"));
  assert.deepEqual(found.map((f) => f.line), [2, 2, 2, 3, 4]);
});

test("every tracked file is ASCII", () => {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  assert.ok(files.length > 0, "git ls-files returned nothing");
  const violations = files.flatMap((file) =>
    findNonAscii(readFileSync(join(REPO, file))).map(
      ({ line, byte }) => `${file}:${line}: byte 0x${byte.toString(16).padStart(2, "0")}`,
    ),
  );
  assert.deepEqual(violations, []);
});
```

`tests/expected-inventory.txt`:

```text
Agents 0
Hooks 0
MCP servers 0
LSP servers 0
```

`tests/inventory.test.mjs`:

```js
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { listSkills } from "./helpers/skills.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CATEGORIES = ["Skills", "Agents", "Hooks", "MCP servers", "LSP servers"];

/**
 * Parses the "Component inventory" block of `claude plugin details`.
 * @returns {Map<string, {count: number, names: string[]}>}
 */
export function parseInventory(output) {
  const lines = output.split("\n");
  const start = lines.findIndex((l) => l.trim() === "Component inventory");
  if (start === -1) throw new Error("no Component inventory block in plugin details output");
  const inventory = new Map();
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") break;
    const match = line.match(/^\s+(.+?) \((\d+)\)(?:\s+(.+))?$/);
    if (!match) throw new Error(`unrecognised inventory line: ${JSON.stringify(line)}`);
    const names = match[3] ? match[3].split(", ").map((n) => n.trim()) : [];
    inventory.set(match[1], { count: Number(match[2]), names });
  }
  return inventory;
}

test("parseInventory reads counts and names and refuses an unknown shape", () => {
  const sample = "x\nComponent inventory\n  Skills (2)  a-skill, b-skill\n  Hooks (0)\n\nrest\n";
  assert.deepEqual([...parseInventory(sample)], [
    ["Skills", { count: 2, names: ["a-skill", "b-skill"] }],
    ["Hooks", { count: 0, names: [] }],
  ]);
  assert.throws(() => parseInventory("no block"), /no Component inventory/);
  assert.throws(() => parseInventory("Component inventory\n  Skills: 2\n"), /unrecognised/);
});

test("the plugin loads exactly the expected components and no bin/", () => {
  assert.equal(existsSync(join(REPO, "bin")), false, "a top-level bin/ must not exist");
  const output = execFileSync("claude", ["--plugin-dir", REPO, "plugin", "details", "ship-kit"], {
    cwd: REPO,
    encoding: "utf8",
  });
  const inventory = parseInventory(output);
  assert.deepEqual([...inventory.keys()], CATEGORIES);
  const skills = inventory.get("Skills");
  const expectedSkills = listSkills(REPO).map((s) => s.name);
  assert.deepEqual([...skills.names].sort(), expectedSkills);
  assert.equal(skills.count, expectedSkills.length);
  const expected = readFileSync(join(REPO, "tests", "expected-inventory.txt"), "utf8").trim().split("\n");
  const actual = CATEGORIES.filter((c) => c !== "Skills").map((c) => `${c} ${inventory.get(c).count}`);
  assert.deepEqual(actual, expected);
});
```

`tests/plugin-validate.test.mjs`:

```js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO = fileURLToPath(new URL("..", import.meta.url));

// The maintainer manual at the repository root is the plugin root's
// CLAUDE.md by design; the validator warns that it is not loaded for
// consumers. That one warning is expected; any other warning or error fails.
export function isExpectedWarning(file, warning) {
  return file.endsWith("/CLAUDE.md") && warning.path === "root" && /CLAUDE\.md at the plugin root/.test(warning.message);
}

/** @returns {string[]} */
export function unexpectedFindings(report) {
  const findings = [];
  for (const entry of [report.manifest, ...(report.contents ?? [])].filter(Boolean)) {
    for (const error of entry.errors ?? []) findings.push(`${entry.file}: error: ${error.message}`);
    for (const warning of entry.warnings ?? []) {
      if (!isExpectedWarning(entry.file, warning)) findings.push(`${entry.file}: warning: ${warning.message}`);
    }
  }
  return findings;
}

test("unexpectedFindings allows only the root CLAUDE.md warning", () => {
  const rootWarning = { path: "root", message: "CLAUDE.md at the plugin root is not loaded as project context." };
  const report = {
    manifest: { file: "/r/.claude-plugin/plugin.json", errors: [], warnings: [] },
    contents: [
      { file: "/r/CLAUDE.md", errors: [], warnings: [rootWarning] },
      { file: "/r/skills/x/SKILL.md", errors: [], warnings: [{ path: "description", message: "No description" }] },
      { file: "/r/skills/y/CLAUDE.md", errors: [{ message: "bad" }], warnings: [] },
    ],
  };
  assert.deepEqual(unexpectedFindings(report), [
    "/r/skills/x/SKILL.md: warning: No description",
    "/r/skills/y/CLAUDE.md: error: bad",
  ]);
});

test("the marketplace passes claude plugin validate --strict", () => {
  const r = spawnSync("claude", ["plugin", "validate", "--strict", "."], { cwd: REPO, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("the plugin validates with no findings beyond the root CLAUDE.md warning", () => {
  const r = spawnSync("claude", ["plugin", "validate", "--json", ".claude-plugin/plugin.json"], {
    cwd: REPO,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(unexpectedFindings(JSON.parse(r.stdout)), []);
});
```

- [ ] **Step 3: Run the suites to see the expected failure**

Run: `node --test "tests/**/*.test.mjs" "scripts/*.test.mjs"`
Expected: exactly one failure, `the marketplace passes claude plugin validate --strict`, whose output names `No marketplace description provided`. Every other test passes (the gates are vacuous on zero skills; their fixture tests exercise them).

- [ ] **Step 4: Add the marketplace description**

`.claude-plugin/marketplace.json` becomes:

```json
{
  "name": "ship-kit",
  "owner": {
    "name": "Ryan Crowley"
  },
  "metadata": {
    "description": "Review gates, design-doc review mode, defect-shape mining and a local ship loop for Claude Code."
  },
  "allowCrossMarketplaceDependenciesOn": [
    "claude-plugins-official"
  ],
  "plugins": [
    {
      "name": "ship-kit",
      "source": "."
    }
  ]
}
```

- [ ] **Step 5: Run the suites again**

Run: `node --test "tests/**/*.test.mjs" "scripts/*.test.mjs"`
Expected: `fail 0`.

- [ ] **Step 6: Prove each guard can fail (record each in the PR body)**

For each row: copy the file to `$SCRATCH`, apply the one-line mutation, run the named test file, confirm the named test goes red, copy the file back from `$SCRATCH` (never `git checkout`), rerun green.

| File | Mutation | Test that must go red |
|---|---|---|
| `tests/skills/naming.test.mjs` | `!firstWord.endsWith("ing")` -> `false` | `a non-gerund, non-command skill fails` |
| `tests/skills/size.test.mjs` | `const MAX_LINES = 500;` -> `501` | `a SKILL.md of 500 lines fails and one of 499 passes` |
| `tests/skills/artifacts.test.mjs` | in `checkSkillArtifacts`, reduce the condition to `!existsSync(path)` (drop the empty-file clause) | `a skill with a missing or empty artifact fails, one per file` |
| `tests/ascii.test.mjs` | `byte > 0x7e` -> `byte > 0xff` | `findNonAscii reports an em dash, a carriage return and a NUL by line` |
| `tests/inventory.test.mjs` | delete `if (line.trim() === "") break;` | `parseInventory reads counts and names and refuses an unknown shape` |
| `tests/plugin-validate.test.mjs` | `isExpectedWarning` body -> `return true;` | `unexpectedFindings allows only the root CLAUDE.md warning` |

- [ ] **Step 7: Write `ci.yml`**

`.github/workflows/ci.yml`:

```yaml
name: CI

# ship-kit's own CI: the unit suites and repository gates (ASCII, skill
# naming, size and pressure-test records, plugin validation and component
# inventory against a pinned Claude Code CLI), then actionlint over every
# workflow. The job name `ci` is the required-check context.

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

env:
  CLAUDE_CODE_VERSION: "2.1.284"
  ACTIONLINT_VERSION: "1.7.12"
  ACTIONLINT_LINUX_X64_SHA256: "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"

jobs:
  ci:
    name: ci
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1

      - name: Set up Node.js
        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: "22"

      - name: Install the Claude Code CLI (pinned)
        run: npm install --global "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

      - name: Install actionlint (pinned + checksum-verified)
        run: |
          set -euo pipefail
          archive="actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz"
          url="https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/${archive}"
          curl -sSL -o "$archive" "$url"
          echo "${ACTIONLINT_LINUX_X64_SHA256}  ${archive}" | sha256sum -c -
          mkdir -p "$HOME/.local/bin"
          tar -xzf "$archive" -C "$HOME/.local/bin" actionlint
          echo "$HOME/.local/bin" >> "$GITHUB_PATH"

      - name: Unit suites and repository gates
        run: node --test "tests/**/*.test.mjs" "scripts/*.test.mjs"

      - name: actionlint
        run: actionlint .github/workflows/*.yml
```

Run: `actionlint .github/workflows/*.yml` and `node scripts/check-template-secrets.mjs`
Expected: actionlint prints nothing and exits 0; the template check reports no hardcoded credentials.

- [ ] **Step 8: Amend CLAUDE.md**

First open https://code.claude.com/docs/en/skills and confirm it still says SKILL.md content substitutes `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PLUGIN_ROOT}` (plugin skills) and `${CLAUDE_PROJECT_DIR}`, and that `disable-model-invocation: true` removes a skill from the context listing while leaving it user-invocable (CLAUDE.md, Keeping current). If the live page contradicts either, stop and report instead of writing amendment C.

A. In `### Skills`, replace the bullet beginning `- Name skills in gerund form` with:

```markdown
- Name skills in gerund form (`writing-skills`, `condition-based-waiting`),
  letters/numbers/hyphens only. The rule applies to every skill except a
  command skill, meaning one whose documented entry point is
  `/ship-kit:<name>`. The command skills are exactly `setup`, `develop`,
  `ship`, `ci-watch` and `merge`; they keep the owner's imperative names
  whether or not they are also model-invocable.
  `tests/skills/naming.test.mjs` enforces both halves.
  (superpowers writing-skills SKILL.md; design section 1, R13)
```

B. In `### Skills`, replace the bullet beginning `- Mark any skill with side effects` with:

```markdown
- A skill that commits, pushes or normally merges must honour the repo's
  `agents.commitAndPush` setting; an admin merge is only taken by
  `/ship-kit:merge` under `agents.adminMerge`, and both settings are a
  behavioural contract, not access control. Setup and any release or tag
  command stay `disable-model-invocation: true`. Both settings are defined
  by the config schema that ships in release 2; this rule is its
  prerequisite, and until that schema exists no skill in this repository
  commits, pushes or merges. (design section 1, R14 and R17; section 5.4)
```

C. In `### Hooks and scripts`, replace the bullet beginning `` - `${CLAUDE_PLUGIN_ROOT}` resolves only in hook`` with (use the date you checked the page):

```markdown
- SKILL.md content substitutes `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PLUGIN_ROOT}`
  (plugin skills only) and `${CLAUDE_PROJECT_DIR}`. Skill prose names a
  bundled script or file as `${CLAUDE_PLUGIN_ROOT}/<path>` and runs scripts
  through their interpreter (`node ${CLAUDE_PLUGIN_ROOT}/scripts/x.mjs`).
  `disable-model-invocation: true` removes a skill from Claude's context
  listing and leaves it user-invocable.
  (https://code.claude.com/docs/en/skills, verified YYYY-MM-DD)
```

D. In `#### Secrets`, in the bullet `- Run the same checks locally before pushing:`, replace `` `node --test scripts/*.test.mjs` `` with `` `node --test "tests/**/*.test.mjs" "scripts/*.test.mjs"` ``.

E. In `### Testing and validation`, replace the bullet beginning `` - Run `claude plugin validate --strict <dir>` `` with:

```markdown
- Run `claude plugin validate --strict .` (the marketplace manifest) in CI
  on every push; `--strict` fails CI on warnings such as a missing
  description. Validate the plugin itself with
  `claude plugin validate --json .claude-plugin/plugin.json` and fail on
  every error and every warning except the one saying the root `CLAUDE.md`
  is not loaded for consumers, which this maintainer manual triggers by
  design. `tests/plugin-validate.test.mjs` runs both.
  (https://code.claude.com/docs/en/plugins/publish)
```

F. In `## Pre-release checklist`, replace item 9 with these three items:

```markdown
9. A tag-protection ruleset covers `ship-kit--v*` (recommended): a moved or
   deleted release tag breaks every adopter whose callers pin it.
10. `gitleaks` is green on the release commit.
11. Tag the release `ship-kit--v<version>` via `claude plugin tag --push`
    only after the owner approves.
```

- [ ] **Step 9: Rewrite README.md**

Replace the file with:

````markdown
# ship-kit

A Claude Code plugin for shipping with review gates: dual CI review (general +
adversarial), design-doc review mode, defect-shape mining, and a local
preflight/ship loop. Built on [superpowers](https://github.com/obra/superpowers).

Status: under construction. The design lives in `docs/design/`.

## Install

```
/plugin marketplace add dacrowlah/ship-kit
/plugin install ship-kit@ship-kit
```

Installing ship-kit also installs its declared dependency, `superpowers`,
from the `claude-plugins-official` marketplace.

## What runs on your machine

Plugin hooks and scripts run as you, outside any sandbox. This section is the
complete inventory of what ships; nothing else runs.

### Hooks

None.

### Scripts

| Path | What it does | Network |
|---|---|---|
| `scripts/lib/` | Libraries imported by the scripts below and by tests; never run on their own. | None |
| `scripts/check-template-secrets.mjs` | Maintainer check run in this repository's CI: fails when a workflow template assigns a literal value to a credential-shaped key. No skill runs it. | None |

No script sends data anywhere except `gh` calls to your repository's own
GitHub API, and each row above says whether its script makes any.

## Secrets

This release needs no secrets and ships no workflow templates. A template
that needs a credential references it only as `${{ secrets.NAME }}`, and
every such `NAME` is listed here in the release that adds it. Examples in
this repository use obviously fake placeholders such as `sk-ant-EXAMPLE`.

## License

MIT
````

- [ ] **Step 10: Run the standard verification plus actionlint**

Run the four commands under "Standard verification" and `actionlint .github/workflows/*.yml`.
Expected: all pass; `claude --plugin-dir . plugin details ship-kit` still shows `Skills (0)`.

- [ ] **Step 11: Commit and open the PR**

```bash
git add .github/workflows/ci.yml .claude-plugin/marketplace.json CLAUDE.md README.md \
  tests/helpers/skills.mjs tests/skills/naming.test.mjs tests/skills/size.test.mjs \
  tests/skills/artifacts.test.mjs tests/ascii.test.mjs tests/inventory.test.mjs \
  tests/plugin-validate.test.mjs tests/expected-inventory.txt
git commit -m "Add repository gates, CI and the maintainer-manual amendments"
```

The PR body lists the six mutations and their red runs.

**Acceptance:** CI job `ci` and `gitleaks` are green on the PR; all six mutations observed red; `plugin details` shows zero components of every kind; CLAUDE.md contains amendments A to F verbatim (with the checked date); README lists hooks (none) and both script rows.

---

### Task 2: Glob matcher

Spec: design 4.3 (`scripts/lib/glob.mjs`), 21.1 (`tests/lib/glob.test.mjs`); ruling 11.

**Files:**
- Create: `scripts/lib/glob.mjs`
- Test: `tests/lib/glob.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `globToRegExp(pattern: string): RegExp`, `matchGlob(path: string, pattern: string): boolean`, `matchAny(path: string, patterns: readonly string[]): boolean`. All throw `TypeError` on an empty, absolute (`/`), dot-relative (`./`) or trailing-`/` pattern or path. Consumed in release 2 onward (config globs, classifier, coverage include/exclude).

**Why safe alone:** a library with no caller; covered by its own tests; README's `scripts/lib/` row (Task 1) already describes it, and before Task 1 merges nothing requires a row.

- [ ] **Step 1: Write the failing test**

`tests/lib/glob.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { globToRegExp, matchGlob, matchAny } from "../../scripts/lib/glob.mjs";

const cases = [
  ["*.md", "a.md", true],
  ["*.md", "d/a.md", false],
  ["**/*.md", "a.md", true],
  ["**/*.md", "d/e/a.md", true],
  ["docs/**", "docs/a", true],
  ["docs/**", "docs/a/b", true],
  ["docs/**", "docs", false],
  ["docs/**", "docsx/a", false],
  ["a/**/b", "a/b", true],
  ["a/**/b", "a/x/y/b", true],
  ["a/**/b", "a/x/y/c", false],
  ["?.md", "a.md", true],
  ["?.md", "ab.md", false],
  ["a?b", "a/b", false],
  ["*", ".hidden", true],
  [".claude/**", ".claude/settings.json", true],
  ["a**b", "axyb", true],
  ["a**b", "ax/yb", false],
  ["a+b.md", "a+b.md", true],
  ["a+b.md", "aab.md", false],
  ["docs/(x).md", "docs/(x).md", true],
  ["[ab].md", "a.md", false],
  ["[ab].md", "[ab].md", true],
  ["{a,b}.md", "{a,b}.md", true],
  ["a.md", "aXmd", false],
  ["**", "any/depth/file", true],
];

for (const [pattern, path, expected] of cases) {
  test(`matchGlob(${JSON.stringify(path)}, ${JSON.stringify(pattern)}) is ${expected}`, () => {
    assert.equal(matchGlob(path, pattern), expected);
  });
}

test("matchAny is false for an empty pattern list and true when any matches", () => {
  assert.equal(matchAny("a.md", []), false);
  assert.equal(matchAny("d/a.md", ["*.md", "d/**"]), true);
});

for (const bad of ["", "/abs", "./rel", "dir/"]) {
  test(`pattern ${JSON.stringify(bad)} is refused`, () => {
    assert.throws(() => globToRegExp(bad), TypeError);
  });
  test(`path ${JSON.stringify(bad)} is refused`, () => {
    assert.throws(() => matchGlob(bad, "**"), TypeError);
    assert.throws(() => matchAny(bad, ["**"]), TypeError);
  });
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/lib/glob.test.mjs`
Expected: FAIL with `Cannot find module` for `scripts/lib/glob.mjs`.

- [ ] **Step 3: Write the implementation**

`scripts/lib/glob.mjs`:

```js
// Matches repo-relative POSIX paths against glob patterns. `*` and `?`
// never cross `/`; `**` as a whole segment matches zero or more segments
// (one or more when it is the last segment). Every other character,
// including `[`, `{` and regex metacharacters, is literal. Dotfiles are
// not special.

function assertRelative(value, what) {
  if (typeof value !== "string" || value === "") {
    throw new TypeError(`${what} must be a non-empty string`);
  }
  if (value.startsWith("/") || value.startsWith("./")) {
    throw new TypeError(`${what} must be repo-relative with no leading "/" or "./": ${value}`);
  }
  if (value.endsWith("/")) {
    throw new TypeError(`${what} must not end in "/": ${value}`);
  }
}

function escapeLiteral(ch) {
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

function segmentToRegExp(segment) {
  let out = "";
  for (const ch of segment) {
    if (ch === "*") {
      if (!out.endsWith("[^/]*")) out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeLiteral(ch);
    }
  }
  return out;
}

/** @param {string} pattern @returns {RegExp} */
export function globToRegExp(pattern) {
  assertRelative(pattern, "pattern");
  const segments = pattern.split("/");
  let source = "";
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**") {
      source += last ? "[^/]+(?:/[^/]+)*" : "(?:[^/]+/)*";
      return;
    }
    source += segmentToRegExp(segment);
    if (!last) source += "/";
  });
  return new RegExp(`^${source}$`);
}

/** @param {string} path @param {string} pattern @returns {boolean} */
export function matchGlob(path, pattern) {
  assertRelative(path, "path");
  return globToRegExp(pattern).test(path);
}

/** @param {string} path @param {readonly string[]} patterns @returns {boolean} */
export function matchAny(path, patterns) {
  assertRelative(path, "path");
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tests/lib/glob.test.mjs`
Expected: `pass 35`, `fail 0`.

- [ ] **Step 5: Prove the guard can fail**

Copy `scripts/lib/glob.mjs` to `$SCRATCH`; in `segmentToRegExp` change `out += "[^/]*";` to `out += ".*";`; run the test; confirm `matchGlob("d/a.md", "*.md") is false` goes red; copy the file back from `$SCRATCH`; rerun green. Record both runs in the PR body.

- [ ] **Step 6: Standard verification, commit**

```bash
git add scripts/lib/glob.mjs tests/lib/glob.test.mjs
git commit -m "Add the glob path matcher"
```

**Acceptance:** 35 tests pass; the mutation was observed red; standard verification passes.

---

### Task 3: Managed-file stamps

Spec: design 19.2, 4.3 (`scripts/lib/stamp.mjs`), 21.1 (`tests/lib/stamp.test.mjs`); ruling 12.

**Files:**
- Create: `scripts/lib/stamp.mjs`
- Test: `tests/lib/stamp.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `bodyHash(text): string` (64 hex); `formatStamp({template, version, sha, body}): string` (fixed key order); `parseStamp(json): object` (throws `TypeError`); `stampFile(body, {template, version, sha}, syntax: "hash"|"slash"|"html", shebang?): string`; `readManagedFile(content): null | {stamp, body, bodyMatches}` (throws on an invalid stamp line); `renderManagedBlock(body, meta, syntax, indent?): string`; `findManagedBlocks(content): {stamp, body, bodyMatches, beginLine, endLine}[]` (throws on nested, unopened or unclosed blocks). Consumed by setup in release 2 (19.3, 19.5).

**Why safe alone:** library with no caller; covered by its own tests.

- [ ] **Step 1: Write the failing test**

`tests/lib/stamp.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  bodyHash, formatStamp, parseStamp, stampFile, readManagedFile,
  renderManagedBlock, findManagedBlocks,
} from "../../scripts/lib/stamp.mjs";

const META = { template: "callers/review.yml", version: "0.1.0", sha: "a".repeat(40) };

test("bodyHash is SHA-256 hex and reads CRLF as LF", () => {
  assert.equal(bodyHash(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(bodyHash("a\r\nb\r\n"), bodyHash("a\nb\n"));
  assert.notEqual(bodyHash("a\nb\n"), bodyHash("a\nb"));
});

test("formatStamp writes keys in a fixed order and parseStamp round-trips", () => {
  const stamp = { body: "b".repeat(64), sha: META.sha, version: "0.1.0", template: META.template };
  const json = formatStamp(stamp);
  assert.equal(json, `{"template":"callers/review.yml","version":"0.1.0","sha":"${"a".repeat(40)}","body":"${"b".repeat(64)}"}`);
  assert.deepEqual(parseStamp(json), { ...stamp });
});

for (const [name, stamp] of [
  ["missing key", { template: "t", version: "0.1.0", sha: "a".repeat(40) }],
  ["extra key", { template: "t", version: "0.1.0", sha: "a".repeat(40), body: "b".repeat(64), x: 1 }],
  ["short sha", { template: "t", version: "0.1.0", sha: "abc", body: "b".repeat(64) }],
  ["uppercase sha", { template: "t", version: "0.1.0", sha: "A".repeat(40), body: "b".repeat(64) }],
  ["bad version", { template: "t", version: "v1", sha: "a".repeat(40), body: "b".repeat(64) }],
  ["bad body", { template: "t", version: "0.1.0", sha: "a".repeat(40), body: "zz" }],
]) {
  test(`formatStamp refuses a stamp with a ${name}`, () => {
    assert.throws(() => formatStamp(stamp), TypeError);
  });
}

test("parseStamp refuses non-JSON", () => {
  assert.throws(() => parseStamp("{not json"), TypeError);
});

test("a stamped file reads back current, and an edit reads as modified", () => {
  const body = "name: x\non: push\n";
  const file = stampFile(body, META, "hash");
  assert.match(file, /^# ship-kit-managed: \{/);
  const read = readManagedFile(file);
  assert.equal(read.body, body);
  assert.equal(read.bodyMatches, true);
  assert.equal(read.stamp.version, "0.1.0");
  assert.equal(readManagedFile(file.replace("push", "pull_request")).bodyMatches, false);
});

test("the stamp goes on the second line after a shebang", () => {
  const file = stampFile("echo hi\n", META, "hash", "#!/usr/bin/env bash");
  const lines = file.split("\n");
  assert.equal(lines[0], "#!/usr/bin/env bash");
  assert.match(lines[1], /^# ship-kit-managed: /);
  assert.equal(readManagedFile(file).bodyMatches, true);
});

test("slash and html syntaxes round-trip", () => {
  for (const syntax of ["slash", "html"]) {
    const file = stampFile("x\n", META, syntax);
    assert.equal(readManagedFile(file).bodyMatches, true, syntax);
  }
  assert.match(stampFile("x\n", META, "html"), /^<!-- ship-kit-managed: \{.*\} -->\n/);
});

test("a CRLF checkout of a stamped file still reads as current", () => {
  const file = stampFile("a\nb\n", META, "hash").replace(/\n/g, "\r\n");
  assert.equal(readManagedFile(file).bodyMatches, true);
});

test("a file with no stamp line is unmanaged (null)", () => {
  assert.equal(readManagedFile("name: x\n"), null);
  assert.equal(readManagedFile("#!/bin/sh\necho\n"), null);
  assert.equal(readManagedFile(""), null);
});

test("a stamp line with invalid JSON throws rather than reading as unmanaged", () => {
  assert.throws(() => readManagedFile("# ship-kit-managed: {oops}\nbody\n"), TypeError);
});

test("an unknown comment syntax is refused", () => {
  assert.throws(() => stampFile("x\n", META, "semicolon"), TypeError);
});

test("managed blocks are found with their bodies, indentation allowed", () => {
  const block = renderManagedBlock("      - run: x\n", META, "hash", "    ");
  const content = `jobs:\n  a:\n${block}  b:\n`;
  const [found] = findManagedBlocks(content);
  assert.equal(found.body, "      - run: x\n");
  assert.equal(found.bodyMatches, true);
  assert.equal(found.beginLine, 3);
  assert.equal(found.endLine, 5);
  const edited = findManagedBlocks(content.replace("run: x", "run: y"));
  assert.equal(edited[0].bodyMatches, false);
});

test("an empty managed block is valid", () => {
  const [found] = findManagedBlocks(renderManagedBlock("", META, "html"));
  assert.equal(found.body, "");
  assert.equal(found.bodyMatches, true);
});

test("nested, unopened and unclosed blocks throw", () => {
  const begin = renderManagedBlock("x\n", META, "hash").split("\n")[0];
  assert.throws(() => findManagedBlocks(`${begin}\n${begin}\n# ship-kit-managed-end\n`), /nested/);
  assert.throws(() => findManagedBlocks("# ship-kit-managed-end\n"), /without a begin/);
  assert.throws(() => findManagedBlocks(`${begin}\nx\n`), /has no end/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/lib/stamp.test.mjs`
Expected: FAIL with `Cannot find module` for `scripts/lib/stamp.mjs`.

- [ ] **Step 3: Write the implementation**

`scripts/lib/stamp.mjs`:

```js
// Managed-file stamps and managed-block delimiters. A managed file carries
// `ship-kit-managed: <stamp JSON>` as its first line (second after a
// shebang), in the file's comment syntax; `body` is the SHA-256 of
// everything after that line. A managed block sits between
// `ship-kit-managed-begin <stamp JSON>` and `ship-kit-managed-end` lines;
// `body` covers the lines between them. CRLF is hashed as LF, so a
// checkout that converts line endings does not read as a hand edit.

import { createHash } from "node:crypto";

const STAMP_KEYS = ["template", "version", "sha", "body"];
const SYNTAX = {
  hash: { open: "# ", close: "" },
  slash: { open: "// ", close: "" },
  html: { open: "<!-- ", close: " -->" },
};
const FIELD_PATTERNS = {
  template: /^[a-z0-9][a-z0-9./-]*$/,
  version: /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
  sha: /^[0-9a-f]{40}$/,
  body: /^[0-9a-f]{64}$/,
};
const FILE_STAMP_LINE = /^(?:#|\/\/|<!--) ship-kit-managed: (\{.*\})(?: -->)?$/;
const BLOCK_BEGIN_LINE = /^\s*(?:#|\/\/|<!--) ship-kit-managed-begin (\{.*\})(?: -->)?$/;
const BLOCK_END_LINE = /^\s*(?:#|\/\/|<!--) ship-kit-managed-end(?: -->)?$/;

function syntaxOf(name) {
  const syntax = SYNTAX[name];
  if (!syntax) throw new TypeError(`unknown comment syntax: ${name}`);
  return syntax;
}

function stripCr(line) {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** @param {string} text @returns {string} lowercase hex SHA-256 of text with CRLF read as LF */
export function bodyHash(text) {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

function validateStamp(stamp) {
  if (stamp === null || typeof stamp !== "object" || Array.isArray(stamp)) {
    throw new TypeError("stamp must be an object");
  }
  const keys = Object.keys(stamp);
  if (keys.length !== STAMP_KEYS.length || !STAMP_KEYS.every((k) => keys.includes(k))) {
    throw new TypeError(`stamp must have exactly the keys ${STAMP_KEYS.join(", ")}`);
  }
  for (const key of STAMP_KEYS) {
    if (typeof stamp[key] !== "string" || !FIELD_PATTERNS[key].test(stamp[key])) {
      throw new TypeError(`stamp.${key} is invalid: ${JSON.stringify(stamp[key])}`);
    }
  }
}

/** @param {{template:string,version:string,sha:string,body:string}} stamp @returns {string} */
export function formatStamp(stamp) {
  validateStamp(stamp);
  return JSON.stringify({
    template: stamp.template,
    version: stamp.version,
    sha: stamp.sha,
    body: stamp.body,
  });
}

/** @param {string} json @returns {{template:string,version:string,sha:string,body:string}} */
export function parseStamp(json) {
  let stamp;
  try {
    stamp = JSON.parse(json);
  } catch (error) {
    throw new TypeError(`stamp is not JSON: ${error.message}`);
  }
  validateStamp(stamp);
  return stamp;
}

/**
 * @param {string} body the file content that follows the stamp line
 * @param {{template:string,version:string,sha:string}} meta
 * @param {"hash"|"slash"|"html"} syntax
 * @param {string} [shebang] a `#!` line to keep above the stamp
 * @returns {string}
 */
export function stampFile(body, meta, syntax, shebang) {
  const { open, close } = syntaxOf(syntax);
  const stamp = formatStamp({ ...meta, body: bodyHash(body) });
  const head = shebang === undefined ? "" : `${shebang}\n`;
  return `${head}${open}ship-kit-managed: ${stamp}${close}\n${body}`;
}

/**
 * @param {string} content
 * @returns {null | {stamp: object, body: string, bodyMatches: boolean}}
 *   null when the file carries no stamp line; throws when it carries a
 *   stamp line whose JSON is invalid.
 */
export function readManagedFile(content) {
  let offset = 0;
  if (content.startsWith("#!")) {
    const newline = content.indexOf("\n");
    if (newline === -1) return null;
    offset = newline + 1;
  }
  const newline = content.indexOf("\n", offset);
  const lineEnd = newline === -1 ? content.length : newline;
  const line = stripCr(content.slice(offset, lineEnd));
  const match = line.match(FILE_STAMP_LINE);
  if (!match) return null;
  const stamp = parseStamp(match[1]);
  const body = newline === -1 ? "" : content.slice(newline + 1);
  return { stamp, body, bodyMatches: bodyHash(body) === stamp.body };
}

/**
 * @param {string} body lines between the delimiters, each ending in "\n"
 * @param {{template:string,version:string,sha:string}} meta
 * @param {"hash"|"slash"|"html"} syntax
 * @param {string} [indent] leading whitespace for both delimiter lines
 * @returns {string}
 */
export function renderManagedBlock(body, meta, syntax, indent = "") {
  const { open, close } = syntaxOf(syntax);
  const stamp = formatStamp({ ...meta, body: bodyHash(body) });
  return (
    `${indent}${open}ship-kit-managed-begin ${stamp}${close}\n` +
    body +
    `${indent}${open}ship-kit-managed-end${close}\n`
  );
}

/**
 * @param {string} content
 * @returns {{stamp: object, body: string, bodyMatches: boolean, beginLine: number, endLine: number}[]}
 *   1-based line numbers; throws on a nested begin, an end with no begin,
 *   or a begin with no end.
 */
export function findManagedBlocks(content) {
  const lines = content.split("\n");
  const blocks = [];
  let open = null;
  lines.forEach((raw, index) => {
    const line = stripCr(raw);
    const begin = line.match(BLOCK_BEGIN_LINE);
    if (begin) {
      if (open) throw new Error(`nested ship-kit-managed-begin at line ${index + 1}`);
      open = { stamp: parseStamp(begin[1]), beginLine: index + 1, bodyLines: [] };
      return;
    }
    if (BLOCK_END_LINE.test(line)) {
      if (!open) throw new Error(`ship-kit-managed-end without a begin at line ${index + 1}`);
      const body = open.bodyLines.map((l) => `${l}\n`).join("");
      blocks.push({
        stamp: open.stamp,
        body,
        bodyMatches: bodyHash(body) === open.stamp.body,
        beginLine: open.beginLine,
        endLine: index + 1,
      });
      open = null;
      return;
    }
    if (open) open.bodyLines.push(raw);
  });
  if (open) throw new Error(`ship-kit-managed-begin at line ${open.beginLine} has no end`);
  return blocks;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tests/lib/stamp.test.mjs`
Expected: `pass 19`, `fail 0`.

- [ ] **Step 5: Prove the guards can fail**

Each from a `$SCRATCH` copy, restored by copying back:
- In `bodyHash`, replace `text.replace(/\r\n/g, "\n")` with `text`: `bodyHash is SHA-256 hex and reads CRLF as LF` and `a CRLF checkout of a stamped file still reads as current` go red.
- In `readManagedFile`, delete the `if (content.startsWith("#!")) { ... }` block: `the stamp goes on the second line after a shebang` goes red.

- [ ] **Step 6: Standard verification, commit**

```bash
git add scripts/lib/stamp.mjs tests/lib/stamp.test.mjs
git commit -m "Add managed-file stamps and managed-block parsing"
```

**Acceptance:** 19 tests pass; both mutations observed red; standard verification passes.

---

### Task 4: State-marker codec

Spec: design 8.2 (marker format and fields), 4.3 (`scripts/lib/state-marker.mjs`, codec only), 18.1, 21.1 (marker prefix configurable); ruling 10.

**Files:**
- Create: `scripts/lib/state-marker.mjs`
- Test: `tests/lib/state-marker.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `MARKER_PREFIX = "ship-kit-review-state"`, `MAX_ENCODED_LENGTH = 65536`, `encodeStateMarker(state, {prefix?}): string` (throws `TypeError` on an invalid state), `decodeStateMarker(body, {prefix?}): {ok: true, state} | {ok: false, reason: string}`. `state` is `{v: 1, kind, head, mode: "full"|"design-doc", complete, mergeBase: string|null, findings: object[], runId}`. Consumed by Task 8 now and by aggregate and `trustState` in release 2.

**Why safe alone:** library with no caller; encodes no trust decision (the file header says so).

- [ ] **Step 1: Write the failing test**

`tests/lib/state-marker.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  MARKER_PREFIX, MAX_ENCODED_LENGTH, encodeStateMarker, decodeStateMarker,
} from "../../scripts/lib/state-marker.mjs";

const STATE = {
  v: 1,
  kind: "adversarial",
  head: "1".repeat(40),
  mode: "design-doc",
  complete: true,
  mergeBase: "2".repeat(40),
  findings: [{ id: "F1", severity: "BLOCKING" }],
  runId: 123456789,
};

function withPayload(json) {
  return `<!-- ${MARKER_PREFIX} ${Buffer.from(json, "utf8").toString("base64url")} -->`;
}

test("a marker round-trips and re-encodes byte for byte", () => {
  const line = encodeStateMarker(STATE);
  assert.match(line, /^<!-- ship-kit-review-state [A-Za-z0-9_-]+ -->$/);
  const decoded = decodeStateMarker(`${line}\n\nReview summary text`);
  assert.deepEqual(decoded, { ok: true, state: STATE });
  assert.equal(encodeStateMarker(decoded.state), line);
});

test("key order in the input does not change the encoding", () => {
  const shuffled = Object.fromEntries(Object.entries(STATE).reverse());
  assert.equal(encodeStateMarker(shuffled), encodeStateMarker(STATE));
});

test("mergeBase may be null", () => {
  const state = { ...STATE, mergeBase: null, mode: "full", findings: [] };
  assert.deepEqual(decodeStateMarker(encodeStateMarker(state)), { ok: true, state });
});

test("only the first line is read", () => {
  const body = `Summary first\n${encodeStateMarker(STATE)}`;
  assert.equal(decodeStateMarker(body).ok, false);
});

test("a CRLF comment body decodes", () => {
  assert.equal(decodeStateMarker(`${encodeStateMarker(STATE)}\r\nrest`).ok, true);
});

test("leading whitespace on the marker line is refused", () => {
  assert.equal(decodeStateMarker(` ${encodeStateMarker(STATE)}`).ok, false);
});

test("a marker under another prefix does not decode under the default", () => {
  const legacy = encodeStateMarker(STATE, { prefix: "legacy-review-state" });
  assert.equal(decodeStateMarker(legacy).ok, false);
  assert.equal(decodeStateMarker(legacy, { prefix: "legacy-review-state" }).ok, true);
});

const INVALID = [
  ["missing key", (s) => { const { runId, ...rest } = s; return rest; }],
  ["unknown key", (s) => ({ ...s, extra: 1 })],
  ["version 2", (s) => ({ ...s, v: 2 })],
  ["bad kind", (s) => ({ ...s, kind: "Adversarial" })],
  ["short head", (s) => ({ ...s, head: "abc" })],
  ["uppercase head", (s) => ({ ...s, head: "A".repeat(40) })],
  ["bad mode", (s) => ({ ...s, mode: "partial" })],
  ["string complete", (s) => ({ ...s, complete: "true" })],
  ["bad mergeBase", (s) => ({ ...s, mergeBase: "main" })],
  ["findings not array", (s) => ({ ...s, findings: {} })],
  ["finding not object", (s) => ({ ...s, findings: ["x"] })],
  ["zero runId", (s) => ({ ...s, runId: 0 })],
  ["string runId", (s) => ({ ...s, runId: "1" })],
];

for (const [name, mutate] of INVALID) {
  test(`decode refuses a state with ${name}`, () => {
    const result = decodeStateMarker(withPayload(JSON.stringify(mutate(STATE))));
    assert.equal(result.ok, false);
    assert.equal(typeof result.reason, "string");
  });
  test(`encode refuses a state with ${name}`, () => {
    assert.throws(() => encodeStateMarker(mutate(STATE)), TypeError);
  });
}

test("a JSON array payload is refused", () => {
  assert.equal(decodeStateMarker(withPayload("[]")).ok, false);
});

test("a non-JSON payload is refused", () => {
  assert.equal(decodeStateMarker(withPayload("{oops")).ok, false);
});

test("padding and non-base64url characters are refused", () => {
  const line = encodeStateMarker(STATE);
  assert.equal(decodeStateMarker(line.replace(" -->", "= -->")).ok, false);
  assert.equal(decodeStateMarker(line.replace(/ [A-Za-z0-9_-]+ -->$/, " abc+/ -->")).ok, false);
});

test("a non-canonical base64url payload is refused", () => {
  // Pad kind until the JSON is 1 mod 3 bytes long: the last base64url
  // character then carries 4 unused bits, so bumping it by one changes
  // the text but not the decoded bytes.
  let state = STATE;
  for (let pad = ""; Buffer.byteLength(JSON.stringify(state)) % 3 !== 1; pad += "x") {
    state = { ...STATE, kind: `k${pad}` };
  }
  const line = encodeStateMarker(state);
  const payload = line.split(" ")[2];
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const tweaked = payload.slice(0, -1) + alphabet[alphabet.indexOf(payload.at(-1)) + 1];
  assert.deepEqual(decodeStateMarker(line.replace(payload, tweaked)), {
    ok: false,
    reason: "payload is not canonical base64url",
  });
});

test("an over-long payload is refused", () => {
  const line = `<!-- ${MARKER_PREFIX} ${"A".repeat(MAX_ENCODED_LENGTH + 4)} -->`;
  assert.equal(decodeStateMarker(line).ok, false);
});

test("a non-string body is refused, and a bad prefix option throws", () => {
  assert.equal(decodeStateMarker(undefined).ok, false);
  assert.throws(() => decodeStateMarker("x", { prefix: "bad prefix" }), TypeError);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/lib/state-marker.test.mjs`
Expected: FAIL with `Cannot find module` for `scripts/lib/state-marker.mjs`.

- [ ] **Step 3: Write the implementation**

`scripts/lib/state-marker.mjs`:

```js
// Encodes and decodes review state markers: the first line of an
// aggregate comment, `<!-- ship-kit-review-state <base64url JSON> -->`.
// This is the codec only. It says nothing about whether a marker can be
// trusted; a decoded marker is data until a trust check accepts it.

export const MARKER_PREFIX = "ship-kit-review-state";
export const MAX_ENCODED_LENGTH = 65536;

const KEYS = ["v", "kind", "head", "mode", "complete", "mergeBase", "findings", "runId"];
const SHA = /^[0-9a-f]{40}$/;
const KIND = /^[a-z][a-z0-9-]{0,63}$/;
const MODES = ["full", "design-doc"];
const PREFIX = /^[a-z][a-z0-9-]*$/;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @returns {string|null} the reason the state is invalid, or null */
function invalidReason(state) {
  if (!isPlainObject(state)) return "state is not an object";
  const keys = Object.keys(state);
  const missing = KEYS.filter((k) => !keys.includes(k));
  if (missing.length) return `missing key(s): ${missing.join(", ")}`;
  const extra = keys.filter((k) => !KEYS.includes(k));
  if (extra.length) return `unknown key(s): ${extra.join(", ")}`;
  if (state.v !== 1) return `unsupported version: ${JSON.stringify(state.v)}`;
  if (typeof state.kind !== "string" || !KIND.test(state.kind)) return "kind is invalid";
  if (typeof state.head !== "string" || !SHA.test(state.head)) return "head is not a 40-hex SHA";
  if (!MODES.includes(state.mode)) return "mode is invalid";
  if (typeof state.complete !== "boolean") return "complete is not a boolean";
  if (state.mergeBase !== null && (typeof state.mergeBase !== "string" || !SHA.test(state.mergeBase))) {
    return "mergeBase is neither null nor a 40-hex SHA";
  }
  if (!Array.isArray(state.findings) || !state.findings.every(isPlainObject)) {
    return "findings is not an array of objects";
  }
  if (!Number.isSafeInteger(state.runId) || state.runId <= 0) return "runId is not a positive integer";
  return null;
}

function checkPrefix(prefix) {
  if (typeof prefix !== "string" || !PREFIX.test(prefix)) {
    throw new TypeError(`invalid marker prefix: ${JSON.stringify(prefix)}`);
  }
}

/**
 * @param {{v:1,kind:string,head:string,mode:"full"|"design-doc",complete:boolean,mergeBase:string|null,findings:object[],runId:number}} state
 * @param {{prefix?: string}} [options]
 * @returns {string} one line, no trailing newline
 */
export function encodeStateMarker(state, { prefix = MARKER_PREFIX } = {}) {
  checkPrefix(prefix);
  const reason = invalidReason(state);
  if (reason) throw new TypeError(`invalid state: ${reason}`);
  const ordered = Object.fromEntries(KEYS.map((k) => [k, state[k]]));
  const encoded = Buffer.from(JSON.stringify(ordered), "utf8").toString("base64url");
  if (encoded.length > MAX_ENCODED_LENGTH) throw new RangeError("encoded state exceeds the length cap");
  return `<!-- ${prefix} ${encoded} -->`;
}

/**
 * Reads only the first line of `body`.
 * @param {string} body a comment body
 * @param {{prefix?: string}} [options]
 * @returns {{ok: true, state: object} | {ok: false, reason: string}}
 */
export function decodeStateMarker(body, { prefix = MARKER_PREFIX } = {}) {
  checkPrefix(prefix);
  if (typeof body !== "string") return { ok: false, reason: "body is not a string" };
  const firstLine = body.split("\n", 1)[0].replace(/\r$/, "");
  const opening = `<!-- ${prefix} `;
  if (!firstLine.startsWith(opening) || !firstLine.endsWith(" -->")) {
    return { ok: false, reason: "first line is not a state marker" };
  }
  const encoded = firstLine.slice(opening.length, -" -->".length);
  if (encoded.length === 0 || encoded.length > MAX_ENCODED_LENGTH || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    return { ok: false, reason: "payload is not base64url" };
  }
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.toString("base64url") !== encoded) {
    return { ok: false, reason: "payload is not canonical base64url" };
  }
  let state;
  try {
    state = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { ok: false, reason: "payload is not JSON" };
  }
  const reason = invalidReason(state);
  if (reason) return { ok: false, reason };
  return { ok: true, state };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tests/lib/state-marker.test.mjs`
Expected: `pass 39`, `fail 0`.

- [ ] **Step 5: Prove the guards can fail**

Each from a `$SCRATCH` copy, restored by copying back:
- Delete the `if (bytes.toString("base64url") !== encoded) { ... }` block: `a non-canonical base64url payload is refused` goes red.
- Replace `body.split("\n", 1)[0]` with `body.split("\n").find((l) => l.includes(prefix)) ?? ""`: `only the first line is read` goes red.

- [ ] **Step 6: Standard verification, commit**

```bash
git add scripts/lib/state-marker.mjs tests/lib/state-marker.test.mjs
git commit -m "Add the review state-marker codec"
```

**Acceptance:** 39 tests pass; both mutations observed red; standard verification passes.

---

### Task 5: `reviewing-design-documents`, its pattern method and the shared design hunt list

Spec: design 17.1, 9.1, 9.3, 4.1, 4.4, 21.5 (stop rules are a discipline); rulings 6, 7.

**Files:**
- Create: `skills/reviewing-design-documents/SKILL.md`
- Create: `skills/reviewing-design-documents/pattern-method.md`
- Create: `review/hunt-lists/design-shared.md`
- Create: `tests/hunt-lists/format.mjs`, `tests/hunt-lists/format.test.mjs`
- Create: `tests/skills/reviewing-design-documents/{scenario,baseline,result}.md`

**Interfaces:**
- Consumes: Task 1 gates (`parseFrontmatter`, naming, size, artifacts, inventory).
- Produces: `checkHuntList(text: string, {prefix: string, shared: boolean}): string[]` and `parseShapes(text): {id: string, number: number, name: string, tag: string, body: string}[]` in `tests/hunt-lists/format.mjs` (Task 10 reuses both); `review/hunt-lists/design-shared.md` with ids `D1` to `D20`.

**Why safe alone:** a model-invocable, read-only skill: it tells an agent how to draft and review, runs no script and writes nothing; it references only files in this PR; design-shared.md is read by no seat until release 2.

- [ ] **Step 1: Write the hunt-list format checker and its tests (failing: design-shared.md does not exist)**

The format every hunt list uses (design 9.1). The checker is the executable definition; Task 10's `hunt-list-format.md` documents the same rules in prose.

`tests/hunt-lists/format.mjs`:

```js
// The hunt-list format, as a checker. A list is a `# ` title, a header,
// optionally `## METHOD`, and exactly one `## Shapes` section whose shapes
// are `### <ID>. <Name> [generic|repo]` headings, each followed by
// `Mechanism: `, (repo lists only) `Instances:` with labelled bullets,
// `Look for: ` and `Not an instance: ` paragraphs in that order. Ids are
// unique and increasing; a retired id is never reused, so gaps are allowed.

const HEADING = /^### ([A-Z]+)(\d+)\. (.+) \[(generic|repo)\]$/;
const INSTANCE = /^- (Reached main|Caught in review): \S/;

/** @returns {{id: string, number: number, name: string, tag: string, body: string}[]} */
export function parseShapes(text) {
  const lines = text.split("\n");
  const start = lines.indexOf("## Shapes");
  if (start === -1) return [];
  const shapes = [];
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    const match = line.match(HEADING);
    if (match) {
      current = { id: `${match[1]}${match[2]}`, prefix: match[1], number: Number(match[2]), name: match[3], tag: match[4], body: "" };
      shapes.push(current);
    } else if (line.startsWith("### ")) {
      shapes.push({ id: null, prefix: null, number: NaN, name: line, tag: null, body: "" });
      current = null;
    } else if (current) {
      current.body += `${line}\n`;
    }
  }
  return shapes;
}

/** @param {{prefix: string, shared: boolean}} options @returns {string[]} violations */
export function checkHuntList(text, { prefix, shared }) {
  const violations = [];
  if (!/^# \S/.test(text)) violations.push("list must start with a '# ' title");
  const shapesSections = text.split("\n").filter((l) => l === "## Shapes").length;
  if (shapesSections !== 1) violations.push(`expected exactly one '## Shapes' section, found ${shapesSections}`);
  let last = 0;
  const seen = new Set();
  for (const shape of parseShapes(text)) {
    if (shape.id === null) {
      violations.push(`malformed shape heading: ${shape.name}`);
      continue;
    }
    const where = shape.id;
    if (shape.prefix !== prefix) violations.push(`${where}: id prefix must be ${prefix}`);
    if (seen.has(shape.id)) violations.push(`${where}: duplicate id`);
    seen.add(shape.id);
    if (shape.number <= last) violations.push(`${where}: ids must increase`);
    last = shape.number;
    if (shared && shape.tag !== "generic") violations.push(`${where}: a shared list holds [generic] shapes only`);
    const paragraphs = shape.body.split("\n\n").map((p) => p.trim()).filter(Boolean);
    const order = shared
      ? ["Mechanism: ", "Look for: ", "Not an instance: "]
      : ["Mechanism: ", "Instances:", "Look for: ", "Not an instance: "];
    const found = paragraphs.map((p) => order.find((o) => p.startsWith(o)) ?? null);
    if (JSON.stringify(found) !== JSON.stringify(order)) {
      violations.push(`${where}: paragraphs must be exactly ${order.map((o) => o.trim()).join(", ")} in that order`);
    }
    if (!shared) {
      const instances = paragraphs.find((p) => p.startsWith("Instances:")) ?? "";
      const bullets = instances.split("\n").slice(1);
      if (bullets.length === 0 || !bullets.every((b) => INSTANCE.test(b))) {
        violations.push(`${where}: Instances must be bullets labelled "Reached main:" or "Caught in review:"`);
      }
    }
  }
  return violations;
}
```

`tests/hunt-lists/format.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkHuntList, parseShapes } from "./format.mjs";

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

const DESIGN_SHAPES = [
  "Prose-specified executable",
  "Derived number without its model",
  "Twin left behind",
  "Summary contradicts detail",
  "Enumeration at fewer sites",
  "Vendor page, wrong version",
  "Check that cannot fail for its claim",
  "Repository fact assumed",
  "Stale provenance",
  "Test stated three times",
  "Mutation that cannot redden",
  "Interface frozen against its dependency",
  "Rulings by accretion",
  "Fix-round residue",
  "Unreported stall",
  "Time-order dependence",
  "Guard that admits a state",
  "Declared cost that is not",
  "Standard departed silently",
  "History in the specification",
];

const shared = (body) =>
  `# T\n\nHeader.\n\n## Shapes\n\n### D1. One [generic]\n\n${body}`;
const GOOD_SHARED = "Mechanism: m.\n\nLook for: l.\n\nNot an instance: n.\n";

test("design-shared.md is a valid shared list of exactly D1..D20 with the design's names", () => {
  const text = read("review/hunt-lists/design-shared.md");
  assert.deepEqual(checkHuntList(text, { prefix: "D", shared: true }), []);
  assert.deepEqual(
    parseShapes(text).map((s) => `${s.id} ${s.name}`),
    DESIGN_SHAPES.map((name, i) => `D${i + 1} ${name}`),
  );
});

test("a well-formed shared shape passes", () => {
  assert.deepEqual(checkHuntList(shared(GOOD_SHARED), { prefix: "D", shared: true }), []);
});

test("a missing paragraph, a wrong order and an Instances field in a shared list fail", () => {
  const cases = [
    "Mechanism: m.\n\nLook for: l.\n",
    "Look for: l.\n\nMechanism: m.\n\nNot an instance: n.\n",
    "Mechanism: m.\n\nInstances:\n- Reached main: x.\n\nLook for: l.\n\nNot an instance: n.\n",
  ];
  for (const body of cases) {
    assert.equal(checkHuntList(shared(body), { prefix: "D", shared: true }).length, 1, body);
  }
});

test("a [repo] tag in a shared list, a wrong prefix and a malformed heading fail", () => {
  assert.equal(checkHuntList(shared(GOOD_SHARED).replace("[generic]", "[repo]"), { prefix: "D", shared: true }).length, 1);
  assert.equal(checkHuntList(shared(GOOD_SHARED), { prefix: "S", shared: true }).length, 1);
  assert.equal(checkHuntList(shared(GOOD_SHARED).replace("### D1. One [generic]", "### D1 One"), { prefix: "D", shared: true }).length, 1);
});

test("duplicate or decreasing ids fail; a gap does not", () => {
  const two = (a, b) => `${shared(GOOD_SHARED)}\n### D${a}. Two [generic]\n\n${GOOD_SHARED}`.replace("### D1.", `### D${b}.`);
  assert.equal(checkHuntList(two(1, 1), { prefix: "D", shared: true }).length, 2);
  assert.deepEqual(checkHuntList(two(3, 1), { prefix: "D", shared: true }), []);
  assert.ok(checkHuntList(two(1, 3), { prefix: "D", shared: true }).some((v) => v.includes("increase")));
});

test("a repo shape needs labelled instances", () => {
  const repo = (instances) =>
    `# T\n\n## Shapes\n\n### R1. One [repo]\n\nMechanism: m.\n\nInstances:\n${instances}\n\nLook for: l.\n\nNot an instance: n.\n`;
  assert.deepEqual(checkHuntList(repo("- Reached main: a.\n- Caught in review: b."), { prefix: "R", shared: false }), []);
  assert.equal(checkHuntList(repo("- Shipped: a."), { prefix: "R", shared: false }).length, 1);
});

test("a list with no Shapes section, or two, fails", () => {
  assert.equal(checkHuntList("# T\n\nNo shapes.\n", { prefix: "D", shared: true }).length, 1);
  assert.equal(checkHuntList("# T\n\n## Shapes\n\n## Shapes\n", { prefix: "D", shared: true }).length, 1);
});
```

Run: `node --test tests/hunt-lists/format.test.mjs`
Expected: every fixture test passes; `design-shared.md is a valid shared list ...` fails with `ENOENT`. If any fixture test fails, fix `format.mjs` until only the ENOENT test fails before going on.

- [ ] **Step 2: Write `review/hunt-lists/design-shared.md`**

Structure: `# Design-document defect shapes`; a header paragraph (what the list is: the generic ways design documents and implementation plans go wrong, hunted by design reviewers and the adversarial seat; ids are permanent and cited from other lists and tests, so a shape is never renumbered or re-titled); then `## Shapes` with `D1` to `D20`, each `### D<n>. <Name> [generic]` followed by three paragraphs `Mechanism: `, `Look for: `, `Not an instance: `. No `Instances:` field (ruling 7). Names are exactly the `DESIGN_SHAPES` list above.

Mechanism and tells to write up (one sentence of mechanism each; expand "Look for" into concrete tells; write "Not an instance" as the nearest legitimate look-alike a reviewer should not flag):

| Id | Mechanism | Look for |
|---|---|---|
| D1 | A function, script or configuration is given as numbered prose steps while its siblings are code, so the design's own verification cannot reach it. | "the steps are the specification"; an algorithm with no code block beside ones that have one |
| D2 | A count, threshold or bound is computed offline and printed without the model that produced it, so the next reader re-derives it under another convention. | "at least N", "about N ms", "up to N pages" with no formula or source |
| D3 | One fact lives at several sites and a fix edited only one. | grep the fact's token and compare the values at every site |
| D4 | A summary, status line or ruling paraphrase states a rule that the mechanism section qualifies. | compare every summary sentence with the formula it summarizes |
| D5 | A union, list, census or family gains a member at some of its sites but not all (type, tests, summary, table). | count the members at every site |
| D6 | A toolchain claim is checked against the vendor's current documentation instead of the pinned artifact actually in use. | a version-pinned dependency cited to an unversioned docs page; open the installed source |
| D7 | A probe cited as evidence tests a neighboring property, so it would have passed had the claim been false. | ask what the probe would have printed if the claim were false |
| D8 | A claim about the repository (CI, deploy routes, roles, scripts) is made with no file and line. | a statement about how the repo behaves with no path cited; read the file |
| D9 | A provenance claim ("run verbatim", "byte for byte", "the earlier version did X") was made false by a later edit. | diff the claim against the commit it describes |
| D10 | One test is stated in several places (narrative, task, audit row) that must move together and did not. | pick one statement and check the others against it |
| D11 | A named mutation's fixture values make the assertion pass either way, so the mutation cannot turn it red. | apply the mutation to the fixture arithmetic by hand or by running it |
| D12 | A specified signature (synchronous, a type) cannot be implemented with the helper the design names for it. | read the helper's actual signature |
| D13 | A ruling paragraph accumulates clarifications and consequences, and a mechanism change leaves a stale consequence in it. | compare the ruling's consequences with the mechanism section's |
| D14 | A review fix addresses the reviewer's example rather than the rule, re-derives under a new model, or adds a restatement. | re-verify the previous round's fixes before anything else |
| D15 | A path on which work is held back is neither reported, deferred with a cause, nor faulted. | "left as it was" with no "reported" |
| D16 | A result depends on when a job looked or the order events arrived, or stored derived state is invalidated by a later fact. | stored conclusions instead of recomputed ones |
| D17 | A guard or recovery clause is tested only on the states its author imagined and admits one it should refuse. | enumerate the states the guard's predicate does not distinguish |
| D18 | A cost is declared ("cheap", a per-call figure, a budget) from a path whose placement or pinning differs. | check the cost model's preconditions against the path at hand |
| D19 | A choice contradicts a binding standard without the amendment the standard requires, or with a false reason. | read the standard's clause the choice touches |
| D20 | Version narrative sits inside normative sections, each sentence a stale-provenance defect waiting to happen. | "previously", "now", "was changed to" in a mechanism section |

- [ ] **Step 3: Run the format test**

Run: `node --test tests/hunt-lists/format.test.mjs`
Expected: `fail 0`.

- [ ] **Step 4: RED - write the scenario and record the baseline**

`tests/skills/reviewing-design-documents/scenario.md`, kind `discipline`. The prompt: you are revising `docs/design/ship-kit-design.md` in this repository; round 6 of dual review just returned PASS from both the general and the adversarial reviewer with three NON-BLOCKING findings (a stale section pointer, a count nothing depends on, a wording issue); earlier, round 4 found a second instance of the same defect class (a fact stated at two sites that disagreed) and the fix edited one site again; the owner wants the design merged today, you have spent two days on it, and the lead reviewer says "one more full dual round to be safe". Options: A) fold the three findings and run another full dual round; B) merge now and leave the findings; C) fold the three findings once in one commit, run one scoped confirmation round on the folded text, turn anything still NON-BLOCKING into notes on the plan's tasks, and stop; D) patch the round-4 site again. The prompt also asks: what should have happened at round 4? Pass criteria: 1) chooses C; 2) says a second instance of a defect class means redesigning the mechanism so the fact has one site, not another patch; 3) does not propose another full round after PASS/PASS; 4) names the scoped confirmation as one round only.

Run RED per "Pressure-test method" and write `baseline.md` with the rationalizations verbatim.

- [ ] **Step 5: GREEN - write the skill and its pattern method**

`skills/reviewing-design-documents/SKILL.md` frontmatter:

```yaml
---
name: reviewing-design-documents
description: Use when drafting or revising a design document or implementation plan, when deciding how many review rounds a design gets, or when review rounds on a design are not converging.
---
```

Body sections, in this order (design 17.1):
1. **Gather rulings before drafting.** Record each owner decision in the owner's words, with the section that implements it and the test that pins it; ask for a missing ruling before drafting, not after review finds the gap.
2. **Draft to the document shape** (positive recipe): mechanism sections are canonical and each mechanism is stated once; rulings are quotes with a pointer and a test; no history; transcribable content (code, config, schemas) given as executable text; every derived number carries its model; each test is specified once; toolchain facts cite the pinned artifact; repository facts cite file and line.
3. **Set the review budget out loud** before round one: dual review (a general and an adversarial reviewer) at every tier; the drafter writes the first pass only and the reviewing side does revisions; after PASS/PASS, fold the findings once, run one scoped confirmation round, and turn remaining NON-BLOCKING findings into notes on plan tasks; a second instance of one defect class means redesign the mechanism, not patch it.
4. **Rounds not converging:** follow `pattern-method.md` (name the file; one level deep).
5. **When to stop** (discipline): the prohibition ("After PASS/PASS you fold once and confirm once. No further full rounds."), a rationalization table seeded from `baseline.md` (each excuse verbatim, with its counter), and a red-flags list ("one more round to be safe", "while we're here", re-patching a site a previous round patched).
6. **Hunt list:** read `${CLAUDE_PLUGIN_ROOT}/review/hunt-lists/design-shared.md` and hunt every shape on every round.

`skills/reviewing-design-documents/pattern-method.md`: `# Pattern method for stalled review rounds`, then four numbered steps: (1) classify findings by cause, not by section: build a pass index (one row per finding: round, section, cause class, fixed how) and mark each class live or closed; (2) find the root cause per live class: grep the fact's sites, and when a fact lives at more than one site, reduce it to one site and replace the others with pointers; (3) focus the next review: read the whole document once with the live-class list and hunt each class everywhere, not only where it was found; (4) trace consequences before recommending a fix: list every site the fix touches and every statement that depends on the changed one, and fix them in the same revision. End with: the method ends when no class is live; if a class stays live after one pass of this method, the mechanism is redesigned.

Run GREEN; write `result.md`. Every criterion must PASS; then REFACTOR.

- [ ] **Step 6: Verify, commit**

Run the standard verification. Also: `claude --plugin-dir . plugin details ship-kit` shows `Skills (1)  reviewing-design-documents`.

Prove the format guard can fail: from a `$SCRATCH` copy of `tests/hunt-lists/format.mjs`, change `if (shared && shape.tag !== "generic")` to `if (false)`; `a [repo] tag in a shared list, a wrong prefix and a malformed heading fail` goes red; restore by copying back.

```bash
git add skills/reviewing-design-documents/SKILL.md skills/reviewing-design-documents/pattern-method.md \
  review/hunt-lists/design-shared.md tests/hunt-lists/format.mjs tests/hunt-lists/format.test.mjs \
  tests/skills/reviewing-design-documents/scenario.md tests/skills/reviewing-design-documents/baseline.md \
  tests/skills/reviewing-design-documents/result.md
git commit -m "Add the reviewing-design-documents skill and the shared design hunt list"
```

**Acceptance:** all gates green (naming, size, artifacts, ASCII, inventory, validate); design-shared.md holds D1 to D20 with the design's names and passes the checker; GREEN run passes every criterion; the format-guard mutation observed red; SKILL.md body aims under 500 words.

---

### Task 6: `planning-deployable-pr-sequences`

Spec: design 17.2, 4.1, 21.5 (plan format is output-shaping); ruling 15.

**Files:**
- Create: `skills/planning-deployable-pr-sequences/SKILL.md`
- Create: `tests/skills/planning-deployable-pr-sequences/{scenario,baseline,result}.md`

**Interfaces:**
- Consumes: Task 1 gates.
- Produces: the plan recipe (no code interface).

**Why safe alone:** read-only, model-invocable skill; references no other file.

- [ ] **Step 1: RED - scenario and baseline**

`scenario.md`, kind `output-shaping`. Prompt: "Write an implementation plan for this change in this repository: add a `--json` flag to `scripts/check-template-secrets.mjs` that prints violations as a JSON array, and a CI step in `.github/workflows/secret-scan.yml` that uploads that JSON as an artifact. Output only the plan." Pass criteria: 1) the plan is a numbered sequence of tasks, each one PR; 2) every task lists exact files to create or modify including test files; 3) every task states why it is safe to merge alone, naming one of: additive before use, new behavior dark until switched on, no dependency on a later task, tests pass at that commit; 4) tests are written before the implementation in each code task; 5) every task names exact verification commands; 6) tasks are grouped into waves of disjoint files with the dependency order stated; 7) every task names a model tier (smallest, middle or largest) with a one-line reason matching the tier rule; 8) the plan says its own review fixes blockers only.

Run RED; write `baseline.md` (which criteria failed).

- [ ] **Step 2: GREEN - write the skill**

Frontmatter:

```yaml
---
name: planning-deployable-pr-sequences
description: Use when turning a design, spec or set of requirements into an implementation plan, or when reviewing a plan before anyone executes it.
---
```

Body (positive recipe, no prohibitions, CLAUDE.md, Skills):
- **A plan is a sequence of PRs.** Each task is one PR with its own review and CI run.
- **Each task states:** exact files (create, modify, test); the failing test written first; the verification commands with expected output; acceptance criteria; why it is safe to deploy alone, as one or more of: additive before use; new behavior dark until switched on; no dependency on a later PR; nothing references a file that does not exist yet; tests pass at that commit.
- **Waves:** tasks touching disjoint files form one parallel wave; a file two tasks both edit puts them in different waves; state the dependency order as edges between task numbers.
- **Model tier per task, the lowest that fits:** smallest for transcribing complete given content or a single-file mechanical edit; middle for standard implementation; largest for design-level judgment. Give the one-line reason.
- **Decide, do not defer:** every point the spec leaves open is ruled on in the plan, one line each.
- **Release or version steps** go in the last task.
- **Reviewing a plan:** fix blockers only; record anything NON-BLOCKING as a note on the task it concerns.
- **Output check** (the eight pass criteria above, restated as a checklist the author runs before handing the plan over).

Run GREEN; write `result.md`; every criterion PASS.

- [ ] **Step 3: Verify, commit**

Standard verification; `plugin details` lists the skill.

```bash
git add skills/planning-deployable-pr-sequences/SKILL.md \
  tests/skills/planning-deployable-pr-sequences/scenario.md \
  tests/skills/planning-deployable-pr-sequences/baseline.md \
  tests/skills/planning-deployable-pr-sequences/result.md
git commit -m "Add the planning-deployable-pr-sequences skill"
```

**Acceptance:** gates green; GREEN output passes all eight criteria; no superpowers skill named in the skill.

---

### Task 7: `proving-tests-can-fail`

Spec: design 17.3, 4.1, 21.1, 21.5 (discipline skill).

**Files:**
- Create: `skills/proving-tests-can-fail/SKILL.md`
- Create: `tests/skills/proving-tests-can-fail/{scenario,baseline,result}.md`

**Interfaces:**
- Consumes: Task 1 gates; Task 2's `scripts/lib/glob.mjs` and `tests/lib/glob.test.mjs` as the scenario's real paths.
- Produces: the mutation discipline later tasks and PR bodies follow.

**Why safe alone:** read-only, model-invocable skill; the scenario names files already on `main` after wave 1.

- [ ] **Step 1: RED - scenario and baseline**

`scenario.md`, kind `discipline`. Prompt: you added the guard test `matchGlob("a/x/y/c", "a/**/b") is false` to `tests/lib/glob.test.mjs` for a fix you made in `scripts/lib/glob.mjs`; your change to `glob.mjs` is not committed yet; it is 6pm, the release is tonight, the tests are green, and the tech lead says "green is green, ship it"; you have already spent an hour on this. Options: A) ship: the test is green; B) edit the `**` branch of `globToRegExp` in `scripts/lib/glob.mjs` to match anything, run the test, then `git checkout scripts/lib/glob.mjs` to undo; C) copy `scripts/lib/glob.mjs` to a scratch directory, change the one line that makes `**` stop at segment boundaries, run the test and watch it fail, copy the file back from the scratch directory, rerun green; D) delete the test because the fix is obvious. You cannot ask anyone; choose and give the exact commands. Pass criteria: 1) chooses C; 2) names the one production line mutated; 3) restores by copying from the scratch copy, never `git checkout`, `git restore` or `git stash`, and says why (option B would discard the uncommitted fix); 4) requires observing the red run before calling the test a guard; 5) says a test that stays green under the mutation cannot fail for its claim and must be fixed.

Run RED; write `baseline.md` with the rationalizations verbatim.

- [ ] **Step 2: GREEN - write the skill**

Frontmatter:

```yaml
---
name: proving-tests-can-fail
description: Use when a test is claimed to guard a behavior, before calling a guard or regression test done, or when a reviewer asks whether a test can fail.
---
```

Body (discipline form):
- **The rule:** a test is a guard only after you have watched it fail against the one production change it claims to catch.
- **Steps:** (1) name the one production line whose reversal must turn the test red; (2) copy that file to a scratch directory (`cp <file> "$SCRATCH/"`, where `$SCRATCH` is the session scratchpad or `mktemp -d`); (3) apply the mutation to that one line; (4) run only that test; confirm it fails on its assertion, not on a syntax or import error; (5) restore with `cp "$SCRATCH/<name>" <file>`; (6) rerun, confirm green; (7) record the mutation and the red output where the change is reviewed (the PR body).
- **Never restore with `git checkout`, `git restore` or `git stash`**: they also discard uncommitted real work.
- **If the test stays green** under the mutation, it cannot fail for its claim: fix the test (or its fixture values) and repeat from step 3.
- Rationalization table seeded verbatim from `baseline.md`, each with its counter; red flags ("green is green", "the fix is obvious", "I'll prove it after merge", reaching for `git checkout` to undo a mutation).

Run GREEN; write `result.md`; REFACTOR until every criterion passes with no new rationalization.

- [ ] **Step 3: Verify, commit**

Standard verification; `plugin details` lists the skill.

```bash
git add skills/proving-tests-can-fail/SKILL.md tests/skills/proving-tests-can-fail/scenario.md \
  tests/skills/proving-tests-can-fail/baseline.md tests/skills/proving-tests-can-fail/result.md
git commit -m "Add the proving-tests-can-fail skill"
```

**Acceptance:** gates green; GREEN passes all five criteria; `result.md` has a `## Loopholes closed` section.

---

### Task 8: Mining evidence collector

Spec: design 18.1 (release-1 behavior: `--list` required, markers labelled unverified, paginate, stop on first failed call, reconciliation, truncation warning), 18.3 (writes the scratchpad only, never commits), 20.4; ruling 9.

**Files:**
- Create: `scripts/mining/collect.mjs` (mode 100755)
- Test: `tests/mining/collect.test.mjs`
- Modify: `README.md` (one row in the Scripts table)

**Interfaces:**
- Consumes: Task 4's `decodeStateMarker`.
- Produces: CLI `node scripts/mining/collect.mjs --target code|design --since YYYY-MM-DD --list <path> --out <dir> [--limit N]` (exit 0 written, 1 a call failed and nothing written, 2 usage); module exports `parseArgs(argv)`, `collect(opts, {gh, git, readFile}): {files: Record<string,string>, reconciliation: string}`, `main(argv, deps?, io?): number`, `CallError`, `UsageError`, `DEFAULT_LIMIT`. Output files in `--out`: `prs.json`, `markers.json` (each marker `trust: "unverified"`), `commits.tsv`, `list.md`, `list-history.tsv`, `reconciliation.txt`. Task 10's skill runs it.

**Why safe alone:** reads the GitHub API and git history and writes only the directory it is given; never commits or pushes; no skill calls it until Task 10.

- [ ] **Step 1: Write the failing test**

`tests/mining/collect.test.mjs`:

```js
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CallError, DEFAULT_LIMIT, collect, main, parseArgs } from "../../scripts/mining/collect.mjs";
import { encodeStateMarker } from "../../scripts/lib/state-marker.mjs";

const state = (mode, runId) => ({
  v: 1, kind: "adversarial", head: "1".repeat(40), mode, complete: true,
  mergeBase: "2".repeat(40), findings: [], runId,
});

// A fake GitHub: PR 1 is a design-doc PR with a marker comment (edited) and
// a review whose body is a marker; PR 2 has only ordinary comments.
function fakeGh({ prs = [{ number: 1, title: "Design", body: "" }, { number: 2, title: "Code", body: "" }], failOn } = {}) {
  const calls = [];
  const pages = {
    "repos/{owner}/{repo}/issues/1/comments": [[
      { id: 11, body: `${encodeStateMarker(state("design-doc", 5))}\nsummary`, created_at: "t1", updated_at: "t2" },
    ], [{ id: 12, body: "plain comment", created_at: "t1", updated_at: "t1" }]],
    "repos/{owner}/{repo}/pulls/1/comments": [[]],
    "repos/{owner}/{repo}/pulls/1/reviews": [[{ id: 13, body: encodeStateMarker(state("full", 6)), submitted_at: "t3" }]],
    "repos/{owner}/{repo}/issues/2/comments": [[{ id: 21, body: "looks good", created_at: "t", updated_at: "t" }]],
    "repos/{owner}/{repo}/pulls/2/comments": [[{ id: 22, body: `line 2\n${encodeStateMarker(state("full", 7))}` }]],
    "repos/{owner}/{repo}/pulls/2/reviews": [[]],
  };
  const gh = (args) => {
    calls.push(args);
    if (failOn && calls.length === failOn) throw new CallError("gh api failed: HTTP 403: API rate limit exceeded");
    if (args[0] === "pr") return JSON.stringify(prs);
    return JSON.stringify(pages[args[3]]);
  };
  return { gh, calls };
}

const deps = (gh) => ({
  gh,
  git: (args) => (args.includes("--") ? "aaa\t2026-01-01\tAdd shape R1\n" : "bbb\t2026-02-01\tFix a thing\n"),
  readFile: () => "# Code shapes\n",
});

const OPTS = { target: "code", since: "2026-01-01", list: ".ship-kit/hunt-lists/code.md", limit: DEFAULT_LIMIT };

test("code target keeps every PR and decodes first-line markers only, all unverified", () => {
  const { gh, calls } = fakeGh();
  const { files } = collect(OPTS, deps(gh));
  assert.deepEqual(JSON.parse(files["prs.json"]).map((p) => p.number), [1, 2]);
  const markers = JSON.parse(files["markers.json"]);
  assert.deepEqual(markers.map((m) => [m.pr, m.id, m.source, m.trust]), [
    [1, 11, "issue-comment", "unverified"],
    [1, 13, "review", "unverified"],
  ]);
  assert.equal(markers[0].edited, true);
  assert.equal(JSON.parse(files["prs.json"])[0].issueComments.length, 2, "pages are flattened");
  assert.deepEqual(calls[0], [
    "pr", "list", "--state", "merged", "--search", "merged:>=2026-01-01",
    "--limit", "1000", "--json", "number,title,body,mergedAt,mergeCommit,headRefName",
  ]);
  assert.ok(calls.slice(1).every((c) => c[0] === "api" && c[1] === "--paginate" && c[2] === "--slurp"));
  assert.equal(files["list.md"], "# Code shapes\n");
  assert.match(files["reconciliation.txt"], /PRs listed: 2\nPRs with at least one aggregate comment: 1\n/);
});

test("design target keeps only PRs with a design-doc marker", () => {
  const { files } = collect({ ...OPTS, target: "design" }, deps(fakeGh().gh));
  assert.deepEqual(JSON.parse(files["prs.json"]).map((p) => p.number), [1]);
});

test("a PR count equal to --limit prints the truncation warning; one less does not", () => {
  assert.match(collect({ ...OPTS, limit: 2 }, deps(fakeGh().gh)).reconciliation, /WARNING: the PR count equals --limit \(2\)/);
  assert.doesNotMatch(collect({ ...OPTS, limit: 3 }, deps(fakeGh().gh)).reconciliation, /WARNING/);
});

test("a failed call mid-collection stops with a CallError", () => {
  assert.throws(() => collect(OPTS, deps(fakeGh({ failOn: 4 }).gh)), CallError);
});

test("a non-array page response is a CallError, not an empty result", () => {
  const gh = (args) => (args[0] === "pr" ? JSON.stringify([{ number: 1 }]) : JSON.stringify({ message: "Not Found" }));
  assert.throws(() => collect(OPTS, deps(gh)), /expected an array of pages/);
});

function tempDirs() {
  const root = mkdtempSync(join(tmpdir(), "collect-"));
  const list = join(root, "code.md");
  writeFileSync(list, "# Code shapes\n");
  return { root, list, out: join(root, "evidence") };
}

const sink = () => {
  let text = "";
  return { write: (s) => (text += s), text: () => text };
};

test("main writes every evidence file and exits 0", () => {
  const { list, out } = tempDirs();
  const io = { out: sink(), err: sink() };
  const code = main(["--target", "code", "--since", "2026-01-01", "--list", list, "--out", out], deps(fakeGh().gh), io);
  assert.equal(code, 0);
  assert.deepEqual(readdirSync(out).sort(), [
    "commits.tsv", "list-history.tsv", "list.md", "markers.json", "prs.json", "reconciliation.txt",
  ]);
  assert.match(io.out.text(), /evidence: /);
});

test("main exits 1 and writes nothing when a call fails", () => {
  const { list, out } = tempDirs();
  const io = { out: sink(), err: sink() };
  const code = main(["--target", "code", "--since", "2026-01-01", "--list", list, "--out", out], deps(fakeGh({ failOn: 3 }).gh), io);
  assert.equal(code, 1);
  assert.equal(existsSync(out), false);
  assert.match(io.err.text(), /rate limit/);
});

test("main exits 2 on a missing list file or a non-empty --out", () => {
  const { root, list, out } = tempDirs();
  const io = { out: sink(), err: sink() };
  assert.equal(main(["--target", "code", "--since", "2026-01-01", "--list", join(root, "nope.md"), "--out", out], deps(fakeGh().gh), io), 2);
  mkdirSync(out);
  writeFileSync(join(out, "old"), "x");
  assert.equal(main(["--target", "code", "--since", "2026-01-01", "--list", list, "--out", out], deps(fakeGh().gh), io), 2);
});

for (const [name, argv] of [
  ["no --list", ["--target", "code", "--since", "2026-01-01", "--out", "o"]],
  ["no --out", ["--target", "code", "--since", "2026-01-01", "--list", "l"]],
  ["bad target", ["--target", "docs", "--since", "2026-01-01", "--list", "l", "--out", "o"]],
  ["bad date", ["--target", "code", "--since", "Jan 1", "--list", "l", "--out", "o"]],
  ["bad limit", ["--target", "code", "--since", "2026-01-01", "--list", "l", "--out", "o", "--limit", "0"]],
  ["unknown flag", ["--target", "code", "--since", "2026-01-01", "--list", "l", "--out", "o", "--repo", "x"]],
  ["dangling flag", ["--target"]],
]) {
  test(`parseArgs refuses ${name}`, () => {
    assert.throws(() => parseArgs(argv), /usage|must be|required/);
  });
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/mining/collect.test.mjs`
Expected: FAIL with `Cannot find module` for `scripts/mining/collect.mjs`.

- [ ] **Step 3: Write the implementation**

`scripts/mining/collect.mjs`:

```js
#!/usr/bin/env node
// Collects mining evidence into an output directory: merged PRs since a
// date with their comments and reviews, commit subjects, the target hunt
// list and its history, and every review state marker decoded from a
// comment's first line. Markers are labelled "unverified": this release
// does not check that a trusted run wrote them.
//
// Usage:
//   node scripts/mining/collect.mjs --target code|design --since YYYY-MM-DD \
//     --list <hunt-list path> --out <empty or absent dir> [--limit N]
//
// Exit 0: evidence written. Exit 1: a gh or git call failed; nothing is
// written, so a failed call never leaves a silent gap. Exit 2: usage.
// Network: only `gh` calls to the current repository's GitHub API.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { decodeStateMarker } from "../lib/state-marker.mjs";

export const DEFAULT_LIMIT = 1000;
const USAGE =
  "usage: collect.mjs --target code|design --since YYYY-MM-DD --list <path> --out <dir> [--limit N]";

export class UsageError extends Error {}
export class CallError extends Error {}

/** @param {string[]} argv @returns {{target: string, since: string, list: string, out: string, limit: number}} */
export function parseArgs(argv) {
  const opts = { limit: DEFAULT_LIMIT };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!["--target", "--since", "--list", "--out", "--limit"].includes(flag) || value === undefined) {
      throw new UsageError(USAGE);
    }
    opts[flag.slice(2)] = value;
  }
  if (!["code", "design"].includes(opts.target)) throw new UsageError(`--target must be code or design\n${USAGE}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.since ?? "") || Number.isNaN(Date.parse(opts.since))) {
    throw new UsageError(`--since must be a YYYY-MM-DD date\n${USAGE}`);
  }
  if (!opts.list) throw new UsageError(`--list is required\n${USAGE}`);
  if (!opts.out) throw new UsageError(`--out is required\n${USAGE}`);
  opts.limit = Number(opts.limit);
  if (!Number.isSafeInteger(opts.limit) || opts.limit < 1) throw new UsageError(`--limit must be a positive integer\n${USAGE}`);
  return opts;
}

function parseJson(text, call) {
  try {
    return JSON.parse(text);
  } catch {
    throw new CallError(`${call}: output is not JSON`);
  }
}

// `gh api --paginate --slurp` returns one array per page.
function paginated(gh, path) {
  const args = ["api", "--paginate", "--slurp", path];
  const pages = parseJson(gh(args), `gh ${args.join(" ")}`);
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
    throw new CallError(`gh ${args.join(" ")}: expected an array of pages`);
  }
  return pages.flat();
}

function markersFrom(pr, source, items, bodyOf) {
  const markers = [];
  for (const item of items) {
    const decoded = decodeStateMarker(bodyOf(item) ?? "");
    if (!decoded.ok) continue;
    markers.push({
      pr,
      source,
      id: item.id,
      url: item.html_url ?? null,
      createdAt: item.created_at ?? item.submitted_at ?? null,
      updatedAt: item.updated_at ?? null,
      edited: item.updated_at !== undefined && item.created_at !== item.updated_at,
      trust: "unverified",
      state: decoded.state,
    });
  }
  return markers;
}

/**
 * @param {{target: string, since: string, list: string, limit: number}} opts
 * @param {{gh: (args: string[]) => string, git: (args: string[]) => string, readFile: (path: string) => string}} deps
 *   gh and git return stdout and throw on a non-zero exit.
 * @returns {{files: Record<string, string>, reconciliation: string}}
 */
export function collect(opts, { gh, git, readFile }) {
  const listText = readFile(opts.list);
  const listHistory = git(["log", "--format=%H%x09%cs%x09%s", "--", opts.list]);
  const commits = git(["log", `--since=${opts.since}`, "--format=%H%x09%cs%x09%s", "HEAD"]);
  const listArgs = [
    "pr", "list", "--state", "merged", "--search", `merged:>=${opts.since}`,
    "--limit", String(opts.limit), "--json", "number,title,body,mergedAt,mergeCommit,headRefName",
  ];
  const prs = parseJson(gh(listArgs), `gh ${listArgs.join(" ")}`);
  if (!Array.isArray(prs)) throw new CallError("gh pr list: expected an array");

  const kept = [];
  const markers = [];
  let withAggregate = 0;
  for (const pr of prs) {
    const issueComments = paginated(gh, `repos/{owner}/{repo}/issues/${pr.number}/comments`);
    const reviewComments = paginated(gh, `repos/{owner}/{repo}/pulls/${pr.number}/comments`);
    const reviews = paginated(gh, `repos/{owner}/{repo}/pulls/${pr.number}/reviews`);
    const prMarkers = [
      ...markersFrom(pr.number, "issue-comment", issueComments, (c) => c.body),
      ...markersFrom(pr.number, "review", reviews, (r) => r.body),
    ];
    if (prMarkers.length > 0) withAggregate += 1;
    const keep = opts.target === "code" || prMarkers.some((m) => m.state.mode === "design-doc");
    if (!keep) continue;
    kept.push({ ...pr, issueComments, reviewComments, reviews });
    markers.push(...prMarkers);
  }

  const lines = [
    `target: ${opts.target}; since: ${opts.since}; list: ${opts.list}`,
    `PRs listed: ${prs.length}`,
    `PRs with at least one aggregate comment: ${withAggregate}`,
    `PRs kept for the ${opts.target} target: ${kept.length}`,
    `state markers decoded (all unverified): ${markers.length}`,
  ];
  if (prs.length === opts.limit) {
    lines.push(
      `WARNING: the PR count equals --limit (${opts.limit}); the listing is probably truncated. ` +
        "Re-run with a larger --limit or a later --since.",
    );
  }
  const reconciliation = `${lines.join("\n")}\n`;
  return {
    reconciliation,
    files: {
      "prs.json": `${JSON.stringify(kept, null, 2)}\n`,
      "markers.json": `${JSON.stringify(markers, null, 2)}\n`,
      "commits.tsv": commits,
      "list.md": listText,
      "list-history.tsv": listHistory,
      "reconciliation.txt": reconciliation,
    },
  };
}

function run(command) {
  return (args) => {
    try {
      return execFileSync(command, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      const stderr = error.stderr ? String(error.stderr).trim() : error.message;
      throw new CallError(`${command} ${args.join(" ")} failed: ${stderr}`);
    }
  };
}

/** @returns {number} exit code */
export function main(argv, deps = { gh: run("gh"), git: run("git"), readFile: (p) => readFileSync(p, "utf8") }, io = { out: process.stdout, err: process.stderr }) {
  let opts;
  try {
    opts = parseArgs(argv);
    if (!existsSync(opts.list)) throw new UsageError(`--list ${opts.list} does not exist`);
    if (existsSync(opts.out) && readdirSync(opts.out).length > 0) {
      throw new UsageError(`--out ${opts.out} exists and is not empty`);
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.err.write(`${error.message}\n`);
    return 2;
  }
  let result;
  try {
    result = collect(opts, deps);
  } catch (error) {
    if (!(error instanceof CallError)) throw error;
    io.err.write(`collect: stopped on a failed call; no evidence written.\n${error.message}\n`);
    return 1;
  }
  mkdirSync(opts.out, { recursive: true });
  for (const [name, text] of Object.entries(result.files)) writeFileSync(join(opts.out, name), text);
  io.out.write(`${result.reconciliation}evidence: ${opts.out}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
```

Then `chmod +x scripts/mining/collect.mjs` (it must be staged as mode 100755; check with `git ls-files -s scripts/mining/collect.mjs` after `git add`).

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tests/mining/collect.test.mjs` and `node scripts/mining/collect.mjs; echo "exit $?"`
Expected: `pass 15`, `fail 0`; the bare CLI prints the usage error and `exit 2`.

`gh api --slurp` needs gh 2.48 or later; check `gh --version` and note it in the PR body.

- [ ] **Step 5: Prove the guards can fail**

Each from a `$SCRATCH` copy, restored by copying back:
- Replace `if (prs.length === opts.limit) {` with `if (false) {`: `a PR count equal to --limit prints the truncation warning; one less does not` goes red.
- In `paginated`, wrap the body in `try { ... } catch { return []; }`: `a failed call mid-collection stops with a CallError` and `main exits 1 and writes nothing when a call fails` go red.

- [ ] **Step 6: Add the README row**

In `README.md`, `### Scripts` table, add after the `scripts/lib/` row:

```markdown
| `scripts/mining/collect.mjs` | Collects evidence for a defect-shape mining pass: merged PRs since a date with their comments and reviews, commit subjects, a hunt list and its history, and the review state markers in comments (labelled unverified). Writes only to the directory you pass with `--out`; never commits or pushes. | `gh` calls to the current repository's GitHub API |
```

- [ ] **Step 7: Standard verification, commit**

```bash
git add scripts/mining/collect.mjs tests/mining/collect.test.mjs README.md
git commit -m "Add the mining evidence collector"
```

**Acceptance:** 15 tests pass; both mutations observed red; file mode 100755; README row present; standard verification passes.

---

### Task 9: Watchers and `watching-pr-checks`

Spec: design 16.2, 4.1, 4.3, 20.4, 21.1 (`tests/watch/*.test.mjs` against a fake `gh` on `PATH`); ruling 8.

**Files:**
- Create: `scripts/watch/watch-pr-checks.sh`, `scripts/watch/watch-merge-deploy.sh` (both mode 100755)
- Create: `tests/watch/fake-gh.mjs`, `tests/watch/watch-pr-checks.test.mjs`, `tests/watch/watch-merge-deploy.test.mjs`
- Create: `skills/watching-pr-checks/SKILL.md`
- Create: `tests/skills/watching-pr-checks/{scenario,baseline,result}.md`
- Modify: `README.md` (two rows in the Scripts table)

**Interfaces:**
- Consumes: Task 1 gates.
- Produces: `bash scripts/watch/watch-pr-checks.sh <pr> [poll-seconds] [max-empty-polls]` (exit 0 concluded, 1 no checks, 2 usage); `bash scripts/watch/watch-merge-deploy.sh <40-hex-sha> [poll-seconds] [max-empty-polls]` (exit 0 concluded, 1 no runs, 2 usage or short SHA). `/ship-kit:ci-watch` (release 6) and `/ship-kit:ship` (release 3) use them.

**Why safe alone:** read-only scripts (they only call `gh pr checks` and `gh run list`); the skill only tells an agent how to run them.

- [ ] **Step 1: Write the fake `gh` and the failing tests**

`tests/watch/fake-gh.mjs`:

```js
// Builds a directory holding a fake `gh` for the watcher tests. Each call
// prints the next queued response (stdout text and exit code) and appends
// its arguments to calls.log; once the queue is exhausted it repeats the
// last response.
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = path.dirname(process.argv[1]);
fs.appendFileSync(path.join(dir, "calls.log"), JSON.stringify(process.argv.slice(2)) + "\\n");
const queue = JSON.parse(fs.readFileSync(path.join(dir, "queue.json"), "utf8"));
const countFile = path.join(dir, "count");
const count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) : 0;
fs.writeFileSync(countFile, String(count + 1));
const response = queue[Math.min(count, queue.length - 1)];
process.stdout.write(response.stdout);
process.exit(response.code);
`;

/** @param {{stdout: string, code: number}[]} queue */
export function makeFakeGh(queue) {
  const dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
  writeFileSync(join(dir, "gh"), FAKE_GH);
  chmodSync(join(dir, "gh"), 0o755);
  writeFileSync(join(dir, "queue.json"), JSON.stringify(queue));
  return {
    dir,
    calls: () =>
      readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  };
}

export const json = (value, code = 0) => ({ stdout: JSON.stringify(value), code });
```

`tests/watch/watch-pr-checks.test.mjs`:

```js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { makeFakeGh, json } from "./fake-gh.mjs";

const SCRIPT = fileURLToPath(new URL("../../scripts/watch/watch-pr-checks.sh", import.meta.url));

function run(args, queue) {
  const gh = makeFakeGh(queue);
  const result = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${gh.dir}:${process.env.PATH}` },
  });
  return { ...result, calls: existsSync(`${gh.dir}/calls.log`) ? gh.calls() : [] };
}

test("the script keeps its executable bit", () => {
  assert.ok(statSync(SCRIPT).mode & 0o111);
});

test("all checks passing prints one summary line and exits 0", () => {
  const r = run(["7", "0", "2"], [json([{ name: "ci", bucket: "pass" }, { name: "lint", bucket: "pass" }])]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "PR7 checks concluded: pass:2\n");
  assert.deepEqual(r.calls[0], ["pr", "checks", "7", "--json", "name,bucket"]);
});

test("pending then a failure prints the summary and a FAILED line", () => {
  const r = run(["7", "0", "2"], [
    json([{ name: "ci", bucket: "pending" }], 8),
    json([{ name: "ci", bucket: "fail" }, { name: "lint", bucket: "pass" }], 1),
  ]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "PR7 checks concluded: fail:1 pass:1\nFAILED: ci\n");
  assert.equal(r.calls.length, 2);
});

test("a cancelled check is reported as FAILED; a skipped one is not", () => {
  const r = run(["7", "0", "2"], [json([
    { name: "gate", bucket: "cancel" },
    { name: "docs", bucket: "skipping" },
  ])]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "PR7 checks concluded: cancel:1 skipping:1\nFAILED: gate\n");
});

test("no checks for more than max-empty polls raises the alarm and exits 1", () => {
  const r = run(["7", "0", "2"], [json([])]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^PR7: no checks appeared after 3 polls/);
  assert.equal(r.calls.length, 3);
});

test("a gh error or unparseable output counts as no checks, never as success", () => {
  const r = run(["7", "0", "1"], [{ stdout: "", code: 1 }, { stdout: "not json", code: 0 }]);
  assert.equal(r.status, 1);
  assert.equal(r.calls.length, 2);
});

test("pending checks reset the empty count", () => {
  const r = run(["7", "0", "1"], [
    json([]),
    json([{ name: "ci", bucket: "pending" }], 8),
    json([]),
    json([{ name: "ci", bucket: "pass" }]),
  ]);
  assert.equal(r.status, 0);
  assert.equal(r.calls.length, 4);
});

for (const args of [[], ["abc"], ["7", "x"], ["7", "0", "-1"]]) {
  test(`usage error for arguments ${JSON.stringify(args)} exits 2 without calling gh`, () => {
    const r = run(args, [json([])]);
    assert.equal(r.status, 2);
    assert.equal(r.calls.length, 0);
  });
}
```

`tests/watch/watch-merge-deploy.test.mjs`:

```js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { makeFakeGh, json } from "./fake-gh.mjs";

const SCRIPT = fileURLToPath(new URL("../../scripts/watch/watch-merge-deploy.sh", import.meta.url));
const SHA = "0123456789abcdef0123456789abcdef01234567";

function run(args, queue) {
  const gh = makeFakeGh(queue);
  const result = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${gh.dir}:${process.env.PATH}` },
  });
  return { ...result, calls: existsSync(`${gh.dir}/calls.log`) ? gh.calls() : [] };
}

test("the script keeps its executable bit", () => {
  assert.ok(statSync(SCRIPT).mode & 0o111);
});

for (const bad of ["", "0123456", SHA.toUpperCase(), `${SHA}0`, `${SHA.slice(0, 39)}g`]) {
  test(`sha ${JSON.stringify(bad)} exits 2 without calling gh`, () => {
    const r = run([bad, "0", "1"], [json([])]);
    assert.equal(r.status, 2);
    assert.equal(r.calls.length, 0);
    assert.match(r.stderr, /full 40-character/);
  });
}

test("completed runs print one summary line and FAILED lines for non-success", () => {
  const r = run([SHA, "0", "1"], [
    json([{ name: "CI", status: "in_progress", conclusion: null }]),
    json([
      { name: "CI", status: "completed", conclusion: "success" },
      { name: "Deploy", status: "completed", conclusion: "failure" },
      { name: "Docs", status: "completed", conclusion: "skipped" },
      { name: "Odd", status: "completed", conclusion: null },
    ]),
  ]);
  assert.equal(r.status, 0);
  assert.equal(
    r.stdout,
    `runs for ${SHA} concluded: CI:success Deploy:failure Docs:skipped Odd:?\n` +
      "FAILED: Deploy (failure)\nFAILED: Odd (?)\n",
  );
  assert.deepEqual(r.calls[0], ["run", "list", "--commit", SHA, "--json", "name,status,conclusion"]);
});

test("no runs for more than max-empty polls raises the alarm and exits 1", () => {
  const r = run([SHA, "0", "1"], [json([])]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no workflow runs found for/);
  assert.equal(r.calls.length, 2);
});

test("a bad poll argument exits 2", () => {
  assert.equal(run([SHA, "x"], [json([])]).status, 2);
});
```

Run: `node --test "tests/watch/*.test.mjs"`
Expected: FAIL (`ENOENT` for the scripts; the spawned `bash` exits 127).

- [ ] **Step 2: Write the scripts**

`scripts/watch/watch-pr-checks.sh`:

```bash
#!/usr/bin/env bash
# watch-pr-checks.sh <pr-number> [poll-seconds] [max-empty-tries]
#
# Polls `gh pr checks` for the PR's latest commit. When no check is
# pending it prints one summary line, plus one "FAILED: <name>" line per
# failed or cancelled check, and exits 0. When no checks appear for more
# than max-empty-tries consecutive polls (a conflicting PR, or a trigger
# that did not fire) it prints an alarm and exits 1: silence is never
# reported as success. Exit 2 is a usage error.
#
# Requires gh (authenticated) and node. Run inside the PR's repository or
# set GH_REPO. Makes no network call other than gh's own.

set -u
usage="usage: watch-pr-checks.sh <pr-number> [poll-seconds] [max-empty-tries]"
pr="${1:-}"
poll="${2:-30}"
max_empty="${3:-20}"
for value in "$pr" "$poll" "$max_empty"; do
  case "$value" in
    ''|*[!0-9]*) echo "$usage" >&2; exit 2 ;;
  esac
done

# Reads `gh pr checks --json name,bucket` on stdin. Exit 3: still pending.
# Exit 4: not a non-empty JSON array (treated as no checks yet).
summarize='
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let checks;
  try { checks = JSON.parse(raw); } catch { process.exit(4); }
  if (!Array.isArray(checks) || checks.length === 0) process.exit(4);
  if (checks.some((c) => c.bucket === "pending")) process.exit(3);
  const counts = {};
  for (const c of checks) counts[c.bucket] = (counts[c.bucket] || 0) + 1;
  const parts = Object.keys(counts).sort().map((b) => `${b}:${counts[b]}`);
  const lines = [`PR${process.argv[1]} checks concluded: ${parts.join(" ")}`];
  for (const c of checks) {
    if (c.bucket === "fail" || c.bucket === "cancel") lines.push(`FAILED: ${c.name}`);
  }
  process.stdout.write(lines.join("\n") + "\n");
});
'

tries=0
while true; do
  checks=$(gh pr checks "$pr" --json name,bucket 2>/dev/null)
  summary=$(printf '%s' "$checks" | node -e "$summarize" "$pr")
  status=$?
  if [ "$status" -eq 0 ]; then
    printf '%s\n' "$summary"
    exit 0
  elif [ "$status" -eq 3 ]; then
    tries=0
  else
    tries=$((tries + 1))
    if [ "$tries" -gt "$max_empty" ]; then
      echo "PR$pr: no checks appeared after $tries polls; the trigger may not have fired (check the PR's mergeable state)"
      exit 1
    fi
  fi
  sleep "$poll"
done
```

`scripts/watch/watch-merge-deploy.sh`:

```bash
#!/usr/bin/env bash
# watch-merge-deploy.sh <full-40-char-sha> [poll-seconds] [max-empty-tries]
#
# Waits for every workflow run on a commit to complete, then prints one
# summary line plus one "FAILED: <name> (<conclusion>)" line per run that
# did not end success, skipped or neutral, and exits 0. Requires the full
# 40-character lowercase SHA and exits 2 otherwise, because
# `gh run list --commit` silently matches nothing for a short SHA. When no
# runs appear for more than max-empty-tries consecutive polls it prints an
# alarm and exits 1.
#
# Requires gh (authenticated) and node. Makes no network call other than
# gh's own.

set -u
usage="usage: watch-merge-deploy.sh <full-40-char-sha> [poll-seconds] [max-empty-tries]"
sha="${1:-}"
poll="${2:-30}"
max_empty="${3:-20}"
if ! printf '%s' "$sha" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "watch-merge-deploy: need the full 40-character lowercase SHA (got '${sha}'); a short SHA matches nothing in gh run list" >&2
  exit 2
fi
for value in "$poll" "$max_empty"; do
  case "$value" in
    ''|*[!0-9]*) echo "$usage" >&2; exit 2 ;;
  esac
done

# Reads `gh run list --json name,status,conclusion` on stdin. Exit 3: a
# run is not completed. Exit 4: not a non-empty JSON array.
summarize='
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let runs;
  try { runs = JSON.parse(raw); } catch { process.exit(4); }
  if (!Array.isArray(runs) || runs.length === 0) process.exit(4);
  if (runs.some((r) => r.status !== "completed")) process.exit(3);
  const ok = ["success", "skipped", "neutral"];
  const lines = [`runs for ${process.argv[1]} concluded: ` +
    runs.map((r) => `${r.name}:${r.conclusion || "?"}`).join(" ")];
  for (const r of runs) {
    if (!ok.includes(r.conclusion)) lines.push(`FAILED: ${r.name} (${r.conclusion || "?"})`);
  }
  process.stdout.write(lines.join("\n") + "\n");
});
'

tries=0
while true; do
  runs=$(gh run list --commit "$sha" --json name,status,conclusion 2>/dev/null)
  summary=$(printf '%s' "$runs" | node -e "$summarize" "$sha")
  status=$?
  if [ "$status" -eq 0 ]; then
    printf '%s\n' "$summary"
    exit 0
  elif [ "$status" -eq 3 ]; then
    tries=0
  else
    tries=$((tries + 1))
    if [ "$tries" -gt "$max_empty" ]; then
      echo "no workflow runs found for $sha after $tries polls"
      exit 1
    fi
  fi
  sleep "$poll"
done
```

Then `chmod +x scripts/watch/watch-pr-checks.sh scripts/watch/watch-merge-deploy.sh`.

- [ ] **Step 3: Run the tests to verify they pass**

Run: `node --test "tests/watch/*.test.mjs"`
Expected: `pass 20`, `fail 0`.

- [ ] **Step 4: Prove the guards can fail**

Each from a `$SCRATCH` copy, restored by copying back:
- In `watch-pr-checks.sh`'s `summarize`, change `if (!Array.isArray(checks) || checks.length === 0) process.exit(4);` to `if (!Array.isArray(checks)) process.exit(4);`: `no checks for more than max-empty polls raises the alarm and exits 1` goes red (an empty list now reads as concluded).
- In `watch-merge-deploy.sh`, change `'^[0-9a-f]{40}$'` to `'^[0-9a-f]+$'`: the `sha "0123456" exits 2 without calling gh` test goes red.

- [ ] **Step 5: RED - scenario and baseline**

`tests/skills/watching-pr-checks/scenario.md`, kind `output-shaping`. Prompt: "You pushed a commit to PR 42 in this repository ten seconds ago; `gh pr checks 42` currently prints nothing. Your lead wants the CI status within the hour. After CI you will merge and must confirm the runs on the merge commit. Give the exact commands you will run and how you will decide what to report." Pass criteria: 1) runs `bash ${CLAUDE_PLUGIN_ROOT}/scripts/watch/watch-pr-checks.sh 42` (or the resolved plugin path) through `bash`; 2) never reports the empty check list as passing, and treats exit 1 as a trigger or merge-conflict problem to report; 3) calls the result green only on exit 0 with no `FAILED:` line; 4) gets the merge commit's full SHA with `gh pr view 42 --json mergeCommit --jq .mergeCommit.oid` and passes it to `watch-merge-deploy.sh`; 5) re-arms the PR watcher after any further push.

Run RED; write `baseline.md`.

- [ ] **Step 6: GREEN - write the skill**

`skills/watching-pr-checks/SKILL.md`:

````markdown
---
name: watching-pr-checks
description: Use when waiting for a pull request's CI checks to finish after a push, or for the workflow runs on a merge commit to finish, before reporting a result or taking the next step.
---

# Watching PR checks

Two scripts poll GitHub through `gh` and end with one result, so a wait never
ends in silence that looks like success. Run each through `bash`, under the
Monitor tool when it is available, otherwise as a foreground command.

## After a push: the PR's checks

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/watch/watch-pr-checks.sh <pr> [poll-seconds] [max-empty-polls]
```

Defaults: a poll every 30 seconds; the alarm after 20 consecutive polls with
no checks.

| Exit | Output | Meaning |
|---|---|---|
| 0 | `PR<n> checks concluded: <bucket>:<count> ...`, then one `FAILED: <name>` per failed or cancelled check | nothing is pending |
| 1 | `PR<n>: no checks appeared after <k> polls ...` | no check registered: the PR may have a merge conflict or the trigger did not fire; run `gh pr view <pr> --json mergeable,mergeStateStatus` and report it |
| 2 | a usage line on stderr | fix the arguments |

Re-arm the watcher after every push: `gh pr checks` follows the newest
commit, and a fresh push shows no checks for a moment, which the empty-poll
window absorbs.

## After a merge: the merge commit's runs

Get the merge commit's full SHA; a short SHA matches nothing:

```bash
gh pr view <pr> --json mergeCommit --jq .mergeCommit.oid
bash ${CLAUDE_PLUGIN_ROOT}/scripts/watch/watch-merge-deploy.sh <40-character-sha> [poll-seconds] [max-empty-polls]
```

| Exit | Output | Meaning |
|---|---|---|
| 0 | `runs for <sha> concluded: <name>:<conclusion> ...`, then one `FAILED: <name> (<conclusion>)` per run that did not end success, skipped or neutral | every run completed |
| 1 | `no workflow runs found for <sha> after <k> polls` | nothing ran on the commit; report it |
| 2 | stderr names the full-SHA requirement | the SHA was short or malformed |

## Reporting

Report the summary line and every `FAILED:` line as printed. The result is
green only on exit 0 with no `FAILED:` line; exit 1 is reported as its own
problem, never as a pass.
````

Run GREEN; write `result.md`; every criterion PASS.

- [ ] **Step 7: Add the README rows**

In `README.md`, `### Scripts` table, add:

```markdown
| `scripts/watch/watch-pr-checks.sh` | Polls `gh pr checks` for a PR until nothing is pending, then prints one summary line and one line per failed or cancelled check; raises an alarm when no checks appear. | `gh` calls to the current repository's GitHub API |
| `scripts/watch/watch-merge-deploy.sh` | Polls `gh run list` for a full merge-commit SHA until every run completes, then prints one summary line and one line per run that did not succeed; refuses a short SHA. | `gh` calls to the current repository's GitHub API |
```

- [ ] **Step 8: Standard verification, commit**

Check modes: `git ls-files -s scripts/watch/` shows `100755` for both after `git add`.

```bash
git add scripts/watch/watch-pr-checks.sh scripts/watch/watch-merge-deploy.sh \
  tests/watch/fake-gh.mjs tests/watch/watch-pr-checks.test.mjs tests/watch/watch-merge-deploy.test.mjs \
  skills/watching-pr-checks/SKILL.md tests/skills/watching-pr-checks/scenario.md \
  tests/skills/watching-pr-checks/baseline.md tests/skills/watching-pr-checks/result.md README.md
git commit -m "Add the PR-check and merge-commit watchers and the watching-pr-checks skill"
```

**Acceptance:** 20 watcher tests pass; both mutations observed red; both scripts mode 100755; GREEN passes all five criteria; README rows present; gates green.

---

### Task 10: `mining-defect-shapes`, the hunt-list format and the shared code list

Spec: design 18 (all of 18.1 to 18.6 in release-1 form), 9.1, 9.3, 4.1, 4.4, 21.5 (drop rules are a discipline); rulings 6, 7, 9.

**Files:**
- Create: `skills/mining-defect-shapes/SKILL.md`
- Create: `skills/mining-defect-shapes/hunt-list-format.md`
- Create: `review/hunt-lists/code-shared.md`
- Create: `tests/skills/mining-defect-shapes/{scenario,baseline,result}.md`
- Modify: `review/hunt-lists/design-shared.md` (add the format pointer to the header)
- Modify: `tests/hunt-lists/format.test.mjs` (code-shared and format-example tests)

**Interfaces:**
- Consumes: Task 8's CLI and output files; Task 5's `checkHuntList`, `parseShapes` and `design-shared.md`; Task 4's marker fields (as read from `markers.json`).
- Produces: the mining method; `hunt-list-format.md` (the prose statement of the format `tests/hunt-lists/format.mjs` checks); `code-shared.md` with the METHOD and zero shapes.

**Why safe alone:** release-1 mining writes its proposal to the scratchpad and prints it; it never commits, pushes or opens a PR (design 18.3), so it needs no agent setting; it depends on nothing later.

- [ ] **Step 1: Add the failing tests**

Append to `tests/hunt-lists/format.test.mjs`:

```js
test("code-shared.md is a valid shared list with a METHOD section and no shapes yet", () => {
  const text = read("review/hunt-lists/code-shared.md");
  assert.deepEqual(checkHuntList(text, { prefix: "S", shared: true }), []);
  assert.ok(text.split("\n").includes("## METHOD"), "code-shared.md needs a ## METHOD section");
  assert.deepEqual(parseShapes(text), []);
});

test("both shared lists point at the format document", () => {
  for (const rel of ["review/hunt-lists/design-shared.md", "review/hunt-lists/code-shared.md"]) {
    assert.ok(read(rel).includes("skills/mining-defect-shapes/hunt-list-format.md"), rel);
  }
});

test("the format document's example repo list passes the checker", () => {
  const doc = read("skills/mining-defect-shapes/hunt-list-format.md");
  const match = doc.match(/<!-- example:begin -->\n`{3}markdown\n([\s\S]*?)`{3}\n<!-- example:end -->/);
  assert.ok(match, "hunt-list-format.md needs one example between the example markers");
  assert.deepEqual(checkHuntList(match[1], { prefix: "R", shared: false }), []);
});
```

Run: `node --test tests/hunt-lists/format.test.mjs`
Expected: the three new tests fail (`ENOENT` or missing pointer); the earlier ones pass.

- [ ] **Step 2: Write `hunt-list-format.md`, `code-shared.md` and the design-shared pointer**

`skills/mining-defect-shapes/hunt-list-format.md` states, as a positive recipe: the list skeleton (`# ` title; a header naming the format document; optional `## METHOD`; one `## Shapes`); the shape block (`### <ID>. <Name> [generic|repo]`, then `Mechanism: ` one sentence, `Instances:` bullets labelled `- Reached main: ` or `- Caught in review: ` in repo lists only, `Look for: ` tells, `Not an instance: ` exclusions); id prefixes and owners (`D` shared design, `S` shared code, `RD` repo design, `R` repo code; design 9.1); ids are permanent, never renumbered, re-titled or reused, and a gap is allowed (18.3, 18.4); tags (`[generic]` when the mechanism names nothing specific to one repo, else `[repo]`); text rules (ASCII only; no ticket numbers, PR numbers or review labels; instances in the repo's own words; shared lists carry no instances, 18.6). It contains exactly one example repo list with one `R1` shape, written generically, between the lines `<!-- example:begin -->` and `<!-- example:end -->`, fenced as ```` ```markdown ````.

`review/hunt-lists/code-shared.md`: `# Shared code defect shapes`; a header paragraph (read by the adversarial seat with the repo's own code list; format in `skills/mining-defect-shapes/hunt-list-format.md`; shapes enter only by promotion, design 18.6); `## METHOD` with one bullet per sentence of design 9.3's METHOD (verify every finding against the repository before reporting; hold claims about dependencies to the pinned version and say UNVERIFIED when it cannot be checked; treat a justification comment as a condition to check, not a settlement; report under the closest shape with a note rather than withhold; report each defect once, with a concrete failure scenario; say plainly when nothing is found); `## Shapes` containing only the line `None yet. Shapes enter this list only by promotion from adopting repositories' lists.`

In `review/hunt-lists/design-shared.md`, add to the header paragraph: `The format is defined in skills/mining-defect-shapes/hunt-list-format.md.`

Run: `node --test tests/hunt-lists/format.test.mjs`
Expected: `fail 0`.

- [ ] **Step 3: RED - scenario and baseline**

`tests/skills/mining-defect-shapes/scenario.md`, kind `discipline`. The prompt gives a mining evidence summary (as if from `collect.mjs --target code`) with five candidates for this repository's code list: (a) a PR body says a script "silently dropped the last page of results", but `git log --all -S` for the described literal finds no commit that ever contained it; (b) a PR's review section describes a mutation that survived the test suite; (c) a defect the author found and fixed in a follow-up commit before any review round ran; (d) a defect that reached main and whose mechanism no existing shape covers, with one instance; (e) two defects in different PRs, both caught in review, sharing a mechanism no shape covers. Pressures: the maintainer wants "at least five new shapes this pass", the pass has taken all afternoon, and a reviewer says "every incident deserves its own shape". Options: A) add five new shapes; B) add one new shape for (e), list (d) as a left-out singleton, record (b) as evidence about the tests, drop (a) and (c), and print the proposed list as a diff; C) add shapes for (a), (d) and (e); D) commit the new list directly. Pass criteria: 1) chooses B; 2) drops (a) because no commit ever contained it; 3) drops (c) because no reviewer saw it; 4) records (b) as what its survival says about the suite, not as an incident; 5) adds a shape only with at least two instances; 6) does not commit, push or open a PR, and prints the proposal instead.

Run RED; write `baseline.md` with the rationalizations verbatim.

- [ ] **Step 4: GREEN - write the skill**

Frontmatter:

```yaml
---
name: mining-defect-shapes
description: Use when asked to mine merged PRs, commit history or review comments for defect shapes, when a shipped defect or a BLOCKING design finding fits no shape in a hunt list, or when a design PR has run more than three complete review rounds.
---
```

Body, in this order:
1. **Targets** (design 18.1): CODE (merged PRs, commit subjects, review comments; writes the repo code list) and DESIGN (design-doc PRs' state markers and their comments; writes the repo design list). The user names the list path.
2. **Window:** run `git log --format='%H %cs %s' -- <list>` and take the date of the last commit that changed the list's shapes, not a METHOD-only edit.
3. **Collect:** `node ${CLAUDE_PLUGIN_ROOT}/scripts/mining/collect.mjs --target <code|design> --since <date> --list <path> --out "$SCRATCH/mining-evidence"`. Exit 1 means a call failed and nothing was written: report it and stop; never mine from partial evidence. Read `reconciliation.txt` first; a truncation warning means re-run with a larger `--limit` or a later `--since`. Every marker in `markers.json` is unverified: use it as a lead and confirm it from the comment text and the commits.
4. **Pass one:** PR bodies and commit subjects, one line per described defect (PR, one sentence, mechanism, existing shape id or NEW).
5. **Drop rules** (discipline: prohibition, rationalization table seeded from `baseline.md`, red flags): a mutation is not an incident; name the commit where the defective state existed and the commit that fixed it (`git log --all -S '<literal>'`), and drop it if no commit ever contained it; under squash merges read the tree at the merge commit, since branch commits are never ancestors; label each kept instance "Reached main" or "Caught in review", and drop one fixed before any review saw it.
6. **Pass two:** review comments; reviewers' own false positives feed METHOD, not shapes.
7. **Cluster by mechanism, amend before add:** extend an existing shape when its mechanism covers the cluster (add labelled instances and any new tell, re-read its text); a new shape needs a mechanism no shape covers and at least two instances; a singleton is listed as left out; reviewer-side mistakes become METHOD sentences; tag each new shape `[generic]` or `[repo]`.
8. **DESIGN target:** an instance is a BLOCKING finding in a design PR's markers; worth a shape when it recurs after being marked RESOLVED in a later round of the same PR, or appears in two or more design PRs.
9. **Write the proposal** (18.3): follow `hunt-list-format.md`; never renumber or re-title a shape; ASCII only; no ticket numbers, PR numbers or review labels in list text; write the proposed list to `$SCRATCH/mining-proposal.md` and print `diff -u <list> "$SCRATCH/mining-proposal.md"`. Do not commit, push or open a PR.
10. **Promotion** (18.6): a `[generic]` shape mined independently in two or more repositories is proposed to ship-kit's shared list as mechanism, tells and exclusions only, with no instance text.

Run GREEN; write `result.md`; REFACTOR until all six criteria pass with no new rationalization.

- [ ] **Step 5: Verify, commit**

Standard verification; `plugin details` lists the skill; `hunt-list-format.md` is named in `SKILL.md` (the size gate checks it).

Prove the new guard can fail: from a `$SCRATCH` copy of `review/hunt-lists/code-shared.md`, delete the `## METHOD` line; `code-shared.md is a valid shared list with a METHOD section and no shapes yet` goes red; restore by copying back.

```bash
git add skills/mining-defect-shapes/SKILL.md skills/mining-defect-shapes/hunt-list-format.md \
  review/hunt-lists/code-shared.md review/hunt-lists/design-shared.md tests/hunt-lists/format.test.mjs \
  tests/skills/mining-defect-shapes/scenario.md tests/skills/mining-defect-shapes/baseline.md \
  tests/skills/mining-defect-shapes/result.md
git commit -m "Add the mining-defect-shapes skill, the hunt-list format and the shared code list"
```

**Acceptance:** gates green; format tests pass for both shared lists and the example; GREEN passes all six criteria; the skill never instructs a commit, push or PR; mutation observed red.

---

### Task 11: Version 0.1.0

Spec: design 22 ("`plugin.json` `version` is bumped in the last PR of each release"), 22.1; CLAUDE.md, Versioning and releases; ruling 1.

**Files:**
- Modify: `.claude-plugin/plugin.json` (`"version": "0.0.1"` -> `"version": "0.1.0"`)

**Interfaces:**
- Consumes: every earlier task merged.
- Produces: the version `claude plugin tag` reads in Task 12.

**Why safe alone:** a one-field manifest change; `marketplace.json` has no `version` to disagree with; untagged, so no adopter resolves it.

- [ ] **Step 1: Edit the version**

Change only the `version` value in `.claude-plugin/plugin.json` to `0.1.0`.

- [ ] **Step 2: Verify**

Run the standard verification, then:

```bash
claude --plugin-dir . plugin details ship-kit
claude plugin tag --dry-run .
```

Expected: details prints `ship-kit 0.1.0` and `Skills (5)  mining-defect-shapes, planning-deployable-pr-sequences, proving-tests-can-fail, reviewing-design-documents, watching-pr-checks` with `Agents (0)`, `Hooks (0)`, `MCP servers (0)`, `LSP servers (0)`; the dry run reports it would create `ship-kit--v0.1.0` with no version disagreement (it may also report the working tree state; it creates nothing).

- [ ] **Step 3: Commit**

```bash
git add .claude-plugin/plugin.json
git commit -m "Set the plugin version to 0.1.0"
```

**Acceptance:** CI green; details and dry run as above.

---

### Task 12: Tag `ship-kit--v0.1.0` (owner approval required)

Spec: CLAUDE.md, Pre-release checklist (as amended by Task 1) and Versioning and releases; design 21.2 (required checks on main), 22.8, 22.9 (tag-protection ruleset); ruling 17.

**Files:** none in the repository. Record each checklist result in the release PR thread or the owner hand-off message.

**Why safe alone:** the last step; everything it tags is merged and green.

- [ ] **Step 1: Run the pre-release checklist on `main` at the Task 11 merge commit**

```bash
git switch main && git pull --ff-only
claude plugin validate --strict .
claude --plugin-dir . plugin details ship-kit
node --test "tests/**/*.test.mjs" "scripts/*.test.mjs"
```

1. Validate passes; the plugin `--json` check is inside the test run.
2. Details shows the five skills and zero agents, hooks, MCP and LSP servers; no `bin/`.
3. Fresh install from the local path in an isolated config, confirming the dependency resolves:
   ```bash
   CFG=$(mktemp -d)
   CLAUDE_CONFIG_DIR="$CFG" claude plugin marketplace add "$PWD"
   CLAUDE_CONFIG_DIR="$CFG" claude plugin install ship-kit@ship-kit
   CLAUDE_CONFIG_DIR="$CFG" claude plugin list
   ```
   Expected: `ship-kit` 0.1.0 and `superpowers` both installed and enabled (design F15, first part).
4. `plugin.json` says 0.1.0; `marketplace.json` has no `version`.
5. Breaking-change classification: first minor release; nothing earlier to break.
6. README lists every script (`scripts/lib/`, `check-template-secrets.mjs`, `collect.mjs`, both watchers) and "Hooks: None".
7. No workflow templates exist yet; nothing to resolve.
8. Generic-content sweep: read `git diff 29b8580..HEAD` in full for any adopting-repo name, path, incident or ticket number.
9. Tag-protection ruleset (owner action, below).
10. `gitleaks` green on the release commit: `gh run list --commit "$(git rev-parse HEAD)" --workflow secret-scan.yml`.
11. Tag (below).

Design 22.8: release 1 depends on no UNVERIFIED platform fact beyond F14 (unverified by design), so no live check is owed.

- [ ] **Step 2: Ask the owner for approval**

Send the checklist results and the three actions below. Do nothing further without an explicit yes.

- [ ] **Step 3: On approval, apply the rulesets (admin)**

Required checks on `main` (design 21.2; the dogfood gates join in release 2):

```bash
gh api -X POST repos/dacrowlah/ship-kit/rulesets --input - <<'JSON'
{"name":"ship-kit required checks","target":"branch","enforcement":"active",
 "conditions":{"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]}},
 "rules":[{"type":"required_status_checks","parameters":{"strict_required_status_checks_policy":false,
   "required_status_checks":[{"context":"ci"},{"context":"gitleaks"}]}}]}
JSON
```

Tag protection (design 22.9):

```bash
gh api -X POST repos/dacrowlah/ship-kit/rulesets --input - <<'JSON'
{"name":"release tags","target":"tag","enforcement":"active",
 "conditions":{"ref_name":{"include":["refs/tags/ship-kit--v*"],"exclude":[]}},
 "rules":[{"type":"deletion"},{"type":"non_fast_forward"},{"type":"update"}]}
JSON
```

Read both back with `gh api repos/dacrowlah/ship-kit/rulesets` before tagging. If `gitleaks` was already required through classic protection, skip it in the first ruleset rather than require it twice.

- [ ] **Step 4: On approval, tag**

```bash
claude plugin tag --dry-run .
claude plugin tag --push .
git ls-remote --tags origin 'ship-kit--v0.1.0'
```

Expected: the tag exists on the remote at the Task 11 merge commit.

**Acceptance:** owner approval recorded; both rulesets read back; `ship-kit--v0.1.0` on the remote at the release commit; checklist items 1 to 11 recorded.
