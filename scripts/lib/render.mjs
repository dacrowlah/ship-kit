// Renders a `<<key>>` template (design 6.5, 19.3; ruling 34) in a single
// pass: inserted values are never rescanned for further placeholders, so a
// value that happens to contain literal `<<other>>` text is left alone, and
// `other` need not be supplied unless the template itself names it.
//
// A placeholder embedded in a line with other text is an inline
// placeholder: its value must be a single line. A placeholder alone on its
// own line, at column 0, is a whole-line placeholder:
//   - when the line directly above it ends a `run: |` (or `- run: |`) block
//     scalar, the value is a fragment: each of its lines is prefixed with
//     that `run:` line's own indentation, plus two more for a `- ` item,
//     plus two more for the fragment itself; empty value lines stay empty;
//   - otherwise the value replaces the line using its own indentation as
//     written in the value; an empty value removes the line entirely.
// A placeholder that is the only content of an indented line (whitespace
// then the placeholder, nothing else) is neither form and is refused: 6.5's
// caller template always puts a whole-line placeholder at column 0, so an
// indented one is a template bug, not a value to fill in.
//
// The template is read once for which keys it names (before any
// substitution), which is what "unreplaced" and "unused" are checked
// against; the rendering pass itself never re-reads its own output.

export class RenderError extends Error {
  constructor(message) {
    super(message);
    this.name = "RenderError";
  }
}

/** Matches one `<<key>>` placeholder; `key` is lowercase letters, digits, underscore, starting with a letter. */
export const PLACEHOLDER = /<<([a-z][a-z0-9_]*)>>/g;

const WHOLE_LINE = new RegExp(`^${PLACEHOLDER.source}$`);
const INDENTED_WHOLE_LINE = new RegExp(`^(\\s+)${PLACEHOLDER.source}$`);
const RUN_LINE = /^(\s*)(- )?run: \|$/;

/** @param {string} text @returns {Set<string>} every placeholder key named anywhere in text */
function placeholderKeysIn(text) {
  const re = new RegExp(PLACEHOLDER.source, "g");
  const keys = new Set();
  let match;
  while ((match = re.exec(text)) !== null) {
    keys.add(match[1]);
  }
  return keys;
}

/**
 * @param {string | undefined} previousLine the raw template line above a whole-line placeholder
 * @returns {string | null} the fragment's line prefix, or null when `previousLine` is not a `run: |` line
 */
function fragmentIndent(previousLine) {
  if (previousLine === undefined) return null;
  const match = previousLine.match(RUN_LINE);
  if (!match) return null;
  const [, indent, dash] = match;
  return indent + (dash ? "  " : "") + "  ";
}

/** @param {string} value @param {string} indent @returns {string[]} */
function fragmentLines(value, indent) {
  return value.split("\n").map((line) => (line === "" ? "" : `${indent}${line}`));
}

/**
 * @param {string} template
 * @param {Record<string, string>} values
 * @returns {string} LF-terminated rendered text
 */
export function render(template, values) {
  const normalized = template.replace(/\r\n/g, "\n");
  const templateKeys = placeholderKeysIn(normalized);

  for (const key of templateKeys) {
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      throw new RenderError(`template placeholder <<${key}>> has no value`);
    }
  }
  for (const key of Object.keys(values)) {
    if (!templateKeys.has(key)) {
      throw new RenderError(`value <<${key}>> is not used by the template`);
    }
  }

  // split("\n") turns a trailing newline into a final "" element that
  // represents no content of its own; drop it so it is not rendered as a
  // real blank line, since the join below always adds exactly one trailing
  // newline back.
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const output = [];

  lines.forEach((line, index) => {
    const whole = line.match(WHOLE_LINE);
    if (whole) {
      const key = whole[1];
      const value = values[key];
      const indent = fragmentIndent(lines[index - 1]);
      if (indent !== null) {
        output.push(...fragmentLines(value, indent));
        return;
      }
      if (value === "") return;
      output.push(...value.split("\n"));
      return;
    }

    const indented = line.match(INDENTED_WHOLE_LINE);
    if (indented) {
      throw new RenderError(`whole-line placeholder <<${indented[2]}>> is not at column 0`);
    }

    output.push(
      line.replace(new RegExp(PLACEHOLDER.source, "g"), (_match, key) => {
        const value = values[key];
        if (value.includes("\n")) {
          throw new RenderError(`inline placeholder <<${key}>> value contains a newline`);
        }
        return value;
      }),
    );
  });

  return `${output.join("\n")}\n`;
}
