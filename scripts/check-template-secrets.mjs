#!/usr/bin/env node
// Scans every YAML/JSON/sh/mjs/md file under templates/, workflows/ and
// .github/workflows/ (whichever of those directories exist) for a
// credential-shaped key (TOKEN, KEY, SECRET, PASSWORD, PAT, CREDENTIAL)
// assigned to anything other than a GitHub Actions expression
// (${{ secrets.X }} or ${{ inputs.X }}) or an empty value.
//
// Run directly: node scripts/check-template-secrets.mjs
// Exit code 0 = no violations, 1 = at least one violation found.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SCAN_ROOTS = ["templates", "workflows", ".github/workflows"];
const SCAN_EXTENSIONS = [".yml", ".yaml", ".json", ".sh", ".mjs", ".md"];

// Matches a credential-shaped key name (case-insensitive), e.g.
// API_TOKEN, apiKey, my-secret, DB_PASSWORD, GH_PAT, AWS_CREDENTIAL.
const CREDENTIAL_KEY_PATTERN =
  /\b[a-zA-Z][a-zA-Z0-9]*(?:[_-][a-zA-Z0-9]+)*\b/;
const CREDENTIAL_NAME_HINT =
  /(TOKEN|KEY|SECRET|PASSWORD|PAT|CREDENTIAL)/i;

// Matches lines shaped like `  SOME_KEY: <value>` or `  some-key: <value>`
// under a `with:` or `env:` block. This is a line-based heuristic, not a
// full YAML parser, so it only inspects the immediate value on the same
// line as the key.
const KEY_VALUE_LINE = /^(\s*)([A-Za-z0-9_.\-]+)\s*:\s*(.*)$/;

// A value is safe when it is empty, or it is exactly a GitHub Actions
// expression referencing secrets.* or inputs.*.
const SAFE_VALUE_PATTERN =
  /^\$\{\{\s*(secrets|inputs)\.[A-Za-z0-9_-]+\s*\}\}$/;

function stripInlineComment(value) {
  // Best-effort: drop a trailing `# ...` comment that isn't inside quotes.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) {
      return value.slice(0, i).trim();
    }
  }
  return value.trim();
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Finds credential-shaped `with:`/`env:` assignments in file content that
 * are not empty and not a `${{ secrets.X }}` / `${{ inputs.X }}` expression.
 *
 * @param {string} content
 * @param {string} filePath used only for the returned violation messages
 * @returns {string[]} human-readable violation descriptions, one per line
 */
export function findTemplateSecretViolations(content, filePath) {
  const violations = [];
  const lines = content.split(/\r?\n/);
  let inRelevantBlock = false;
  let blockIndent = null;

  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const blockHeaderMatch = rawLine.match(/^(\s*)(with|env)\s*:\s*$/);
    if (blockHeaderMatch) {
      inRelevantBlock = true;
      blockIndent = blockHeaderMatch[1].length;
      return;
    }

    if (inRelevantBlock) {
      // Blank lines don't end the block.
      if (rawLine.trim() === "") return;

      const currentIndent = rawLine.match(/^(\s*)/)[1].length;
      if (currentIndent <= blockIndent) {
        inRelevantBlock = false;
        blockIndent = null;
        // Fall through: this line might itself open a new with:/env: block,
        // handled on the next iteration since we `return` above for those.
      }
    }

    if (!inRelevantBlock) return;

    const kv = rawLine.match(KEY_VALUE_LINE);
    if (!kv) return;

    const key = kv[2];
    if (!CREDENTIAL_KEY_PATTERN.test(key)) return;
    if (!CREDENTIAL_NAME_HINT.test(key)) return;

    const rawValue = stripInlineComment(kv[3]);
    if (rawValue === "") return; // empty value is allowed

    const value = unquote(rawValue);
    if (value === "") return;
    if (SAFE_VALUE_PATTERN.test(value)) return;

    violations.push(
      `${filePath}:${lineNumber}: credential-shaped key "${key}" is assigned ` +
        `"${value}", not an empty value or a \${{ secrets.X }} / ` +
        `\${{ inputs.X }} expression`,
    );
  });

  return violations;
}

function walk(dir) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walk(fullPath));
    } else if (SCAN_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * @param {string} cwd the directory whose scan roots are checked
 * @param {{ log: (line: string) => void, error: (line: string) => void }} out
 * @returns {number} the exit code
 */
export function main(cwd = process.cwd(), out = console) {
  const files = SCAN_ROOTS.flatMap((root) => walk(join(cwd, root)));

  if (files.length === 0) {
    out.log(
      "check-template-secrets: no templates/, workflows/ or " +
        ".github/workflows/ directories found; nothing to scan.",
    );
    return 0;
  }

  const allViolations = [];
  for (const file of files) {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const content = readFileSync(file, "utf8");
    const relPath = relative(cwd, file);
    allViolations.push(...findTemplateSecretViolations(content, relPath));
  }

  if (allViolations.length > 0) {
    out.error("check-template-secrets: found hardcoded credential values:");
    for (const violation of allViolations) {
      out.error(`  ${violation}`);
    }
    return 1;
  }

  out.log(
    `check-template-secrets: scanned ${files.length} file(s), no hardcoded credentials found.`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
