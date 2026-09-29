// Finds every `run:` value in a workflow or template as raw text, by a
// line-based scan rather than a YAML parse, so a template file holding
// `<<placeholders>>` (which are not valid YAML on their own) still scans
// cleanly. `runBodies`/`scriptBodies` are for exactly that case (a `.sh`
// template, or any other non-YAML text) and are not the gate over real
// YAML files: a line scan cannot tell a `run:` key line from an equivalent
// flow mapping, quoted key, or alias, and a construct outside what the
// scan recognizes is silently treated as if it held no `run:`/`script:`
// value at all. `yamlExpressionViolations` is the gate for an actual YAML
// document: it walks the parsed tree instead, so it sees a `run:`/`script:`
// value regardless of which supported spelling produced it, and refuses
// (via `yaml.mjs`) any construct that could be hiding one from it.

import { findKeyOccurrences } from "./yaml.mjs";

/**
 * Matches a `run:` (or a sequence item's `- run:`) key at the start of a
 * line's trimmed content. Group 1 is the optional `- ` dash prefix; group 2
 * is whatever trails the colon on the same line (possibly empty, or a block
 * scalar indicator such as `|`).
 */
function keyPattern(key) {
  return new RegExp(`^(-\\s+)?${key}:(?:\\s*(.*))?$`);
}

/**
 * @param {string} text
 * @param {string} key the mapping key to scan for ("run" or "script")
 * @returns {{ line: number, text: string }[]} every line of every matching
 *   key's value, inline or block, in file order
 */
function bodiesForKey(text, key) {
  const lines = text.split(/\r\n|\r|\n/);
  const pattern = keyPattern(key);
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const indent = raw.length - raw.trimStart().length;
    const trimmedStart = raw.slice(indent);
    const match = trimmedStart.match(pattern);
    if (!match) continue;

    const dashPrefixLength = match[1] ? match[1].length : 0;
    const keyColumn = indent + dashPrefixLength;
    const inlineValue = (match[2] ?? "").replace(/\s+$/, "");
    if (inlineValue !== "") {
      results.push({ line: i + 1, text: inlineValue });
    }

    let j = i + 1;
    while (j < lines.length) {
      const bodyLine = lines[j];
      if (bodyLine.trim() === "") {
        results.push({ line: j + 1, text: "" });
        j++;
        continue;
      }
      const bodyIndent = bodyLine.length - bodyLine.trimStart().length;
      if (bodyIndent <= keyColumn) break;
      results.push({ line: j + 1, text: bodyLine });
      j++;
    }
    i = j - 1;
  }
  return results;
}

/**
 * @param {string} text
 * @returns {{ line: number, text: string }[]} every `run:` value's lines
 */
export function runBodies(text) {
  return bodiesForKey(text, "run");
}

/**
 * `actions/github-script`'s `script:` input carries the same class of risk
 * as `run:` (it is interpreted, and an expression substituted into it before
 * that interpretation runs untrusted text). Scanned the same way.
 * @param {string} text
 * @returns {{ line: number, text: string }[]} every `script:` value's lines
 */
export function scriptBodies(text) {
  return bodiesForKey(text, "script");
}

const RUN_AND_SCRIPT_KEYS = ["run", "script"];
const EXPRESSION_MARKER = "${{";

/**
 * The gate for a real YAML document: every `run:`/`script:` value anywhere
 * in the parsed tree (`yaml.mjs`'s `findKeyOccurrences`) that contains an
 * expression. A document holding a construct `yaml.mjs` cannot represent
 * (an anchor, alias, tag, folded scalar, non-empty flow mapping, second
 * document, duplicate key or tab in indentation) throws `YamlSubsetError`
 * instead of returning: the caller decides how to report that as a
 * violation, since it means this scan cannot see the whole document, not
 * that the document is clean.
 * @param {string} text
 * @returns {{ line: number, text: string }[]} every run/script value containing an expression
 */
export function yamlExpressionViolations(text) {
  return findKeyOccurrences(text, RUN_AND_SCRIPT_KEYS)
    .filter((occurrence) => typeof occurrence.value === "string" && occurrence.value.includes(EXPRESSION_MARKER))
    .map((occurrence) => ({ line: occurrence.line, text: occurrence.value }));
}
