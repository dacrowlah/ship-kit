// A strict YAML subset reader for tests only (ruling: no runtime YAML
// parser ships in scripts/**). It supports exactly the constructs the
// repository's workflows and templates use -- comments, block mappings and
// sequences (including mapping items inside a sequence), plain/quoted
// scalars, flow sequences of scalars, empty flow collections, and literal
// block scalars (`|`, `|-`) -- and throws on everything else (anchors,
// aliases, tags, folded scalars, non-empty flow mappings, multiple
// documents, duplicate keys, tabs in indentation), so a workflow using a
// construct outside the subset fails loudly instead of being silently
// misread. `tests/lib/yaml.test.mjs`-style cross-checks against `yq` prove
// it agrees with a real parser on every real file it is pointed at.

export class YamlSubsetError extends Error {}

/**
 * @param {string} text
 * @returns {string[]}
 */
function splitLines(text) {
  return text.split(/\r\n|\r|\n/);
}

/**
 * A line starts a comment at the first unquoted `#` preceded by whitespace
 * or the start of line; everything from there to end of line is dropped.
 * Quote state tracks single quotes (`''` is an escaped quote) and double
 * quotes (`\` escapes the next character).
 * @param {string} line
 * @returns {string}
 */
function stripInlineComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inSingle) {
      if (ch === "'") {
        if (line[i + 1] === "'") {
          i++;
          continue;
        }
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * @param {string} line
 * @returns {boolean} whether the line has any content once its comment is stripped
 */
function isSignificantLine(line) {
  return stripInlineComment(line).trim() !== "";
}

/**
 * @param {string[]} lines
 * @param {number} start
 * @returns {number} the index of the next significant line at or after `start`, or `lines.length`
 */
function nextSignificant(lines, start) {
  let i = start;
  while (i < lines.length && !isSignificantLine(lines[i])) i++;
  return i;
}

/**
 * @param {string[]} lines
 * @param {number} index
 * @returns {{ indent: number, content: string, lineNo: number }}
 */
function lineInfo(lines, index) {
  const line = lines[index];
  const lineNo = index + 1;
  const leading = line.match(/^[ \t]*/)[0];
  if (leading.includes("\t")) {
    throw new YamlSubsetError(`tab in indentation at line ${lineNo}`);
  }
  const indent = leading.length;
  const content = stripInlineComment(line).slice(indent).replace(/\s+$/, "");
  return { indent, content, lineNo };
}

/**
 * @param {string} content full line content (indent already stripped)
 * @returns {boolean}
 */
function isSeqItem(content) {
  return content === "-" || content.startsWith("- ");
}

/**
 * @param {string} text a quoted scalar at the start of `text`
 * @param {number} lineNo
 * @returns {{ value: string, rest: string }}
 */
function readQuotedScalar(text, lineNo) {
  if (text[0] === '"') return readDoubleQuoted(text, lineNo);
  if (text[0] === "'") return readSingleQuoted(text, lineNo);
  throw new YamlSubsetError(`expected a quoted scalar at line ${lineNo}`);
}

const DOUBLE_QUOTE_ESCAPES = { "\\": "\\", '"': '"', n: "\n", t: "\t" };

/**
 * @param {string} text
 * @param {number} lineNo
 * @returns {{ value: string, rest: string }}
 */
function readDoubleQuoted(text, lineNo) {
  let value = "";
  let i = 1;
  let closed = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      i++;
      closed = true;
      break;
    }
    if (ch === "\\") {
      const next = text[i + 1];
      if (!(next in DOUBLE_QUOTE_ESCAPES)) {
        throw new YamlSubsetError(`unsupported escape sequence "\\${next}" at line ${lineNo}`);
      }
      value += DOUBLE_QUOTE_ESCAPES[next];
      i += 2;
      continue;
    }
    value += ch;
    i++;
  }
  if (!closed) throw new YamlSubsetError(`unterminated double-quoted scalar at line ${lineNo}`);
  return { value, rest: text.slice(i) };
}

/**
 * @param {string} text
 * @param {number} lineNo
 * @returns {{ value: string, rest: string }}
 */
function readSingleQuoted(text, lineNo) {
  let value = "";
  let i = 1;
  let closed = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'") {
      if (text[i + 1] === "'") {
        value += "'";
        i += 2;
        continue;
      }
      i++;
      closed = true;
      break;
    }
    value += ch;
    i++;
  }
  if (!closed) throw new YamlSubsetError(`unterminated single-quoted scalar at line ${lineNo}`);
  return { value, rest: text.slice(i) };
}

/**
 * Finds the first `:` at flow-bracket depth 0, outside any quote, that is
 * followed by whitespace or end of string -- the mapping key/value
 * separator. Returns -1 when the content has no such colon.
 * @param {string} content
 * @returns {number}
 */
function findTopLevelColon(content) {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inSingle) {
      if (ch === "'") {
        if (content[i + 1] === "'") {
          i++;
          continue;
        }
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "[" || ch === "{") {
      depth++;
      continue;
    }
    if (ch === "]" || ch === "}") {
      depth--;
      continue;
    }
    if (ch === ":" && depth === 0) {
      const nextCh = content[i + 1];
      if (nextCh === undefined || /\s/.test(nextCh)) return i;
    }
  }
  return -1;
}

/**
 * @param {string} content
 * @returns {boolean} whether `content` opens with a mapping key (plain or quoted)
 */
function looksLikeMappingKey(content) {
  if (content[0] === '"' || content[0] === "'") {
    try {
      const { rest } = readQuotedScalar(content, 0);
      const trimmed = rest.trimStart();
      return trimmed === ":" || trimmed.startsWith(": ");
    } catch {
      return false;
    }
  }
  return findTopLevelColon(content) !== -1;
}

/**
 * @param {string} content a mapping key line, e.g. `foo: bar` or `"foo":`
 * @param {number} lineNo
 * @returns {{ key: string, rawValue: string }}
 */
function splitMappingLine(content, lineNo) {
  if (content[0] === '"' || content[0] === "'") {
    const { value: key, rest } = readQuotedScalar(content, lineNo);
    const trimmedRest = rest.trimStart();
    if (trimmedRest === ":") return { key, rawValue: "" };
    if (trimmedRest.startsWith(": ")) return { key, rawValue: trimmedRest.slice(2).trim() };
    throw new YamlSubsetError(`invalid mapping entry at line ${lineNo}`);
  }
  const idx = findTopLevelColon(content);
  if (idx === -1) {
    throw new YamlSubsetError(`expected a mapping entry ("key: value") at line ${lineNo}`);
  }
  return { key: content.slice(0, idx).trim(), rawValue: content.slice(idx + 1).trim() };
}

/**
 * @param {string} text a plain scalar (no quotes)
 * @returns {string | number | boolean | null}
 */
function parsePlainScalar(text) {
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+$/.test(text)) return Number(text);
  return text;
}

/**
 * @param {string} text a single scalar (quoted or plain), no flow brackets
 * @param {number} lineNo
 * @returns {string | number | boolean | null}
 */
function parseScalar(text, lineNo) {
  const first = text[0];
  if (first === '"') {
    const { value, rest } = readDoubleQuoted(text, lineNo);
    if (rest.trim() !== "") throw new YamlSubsetError(`unexpected content after a quoted scalar at line ${lineNo}`);
    return value;
  }
  if (first === "'") {
    const { value, rest } = readSingleQuoted(text, lineNo);
    if (rest.trim() !== "") throw new YamlSubsetError(`unexpected content after a quoted scalar at line ${lineNo}`);
    return value;
  }
  if (first === "&") throw new YamlSubsetError(`anchors are not supported at line ${lineNo}`);
  if (first === "*") throw new YamlSubsetError(`aliases are not supported at line ${lineNo}`);
  if (first === "!") throw new YamlSubsetError(`tags are not supported at line ${lineNo}`);
  if (first === ">") throw new YamlSubsetError(`folded scalars are not supported at line ${lineNo}`);
  if (first === "{") throw new YamlSubsetError(`flow mappings are not supported at line ${lineNo}`);
  return parsePlainScalar(text);
}

/**
 * Splits a flow sequence's inner text on top-level commas, respecting quotes.
 * @param {string} inner
 * @returns {string[]}
 */
function splitFlowItems(inner) {
  const items = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inSingle) {
      current += ch;
      if (ch === "'") {
        if (inner[i + 1] === "'") {
          current += "'";
          i++;
        } else {
          inSingle = false;
        }
      }
      continue;
    }
    if (inDouble) {
      current += ch;
      if (ch === "\\") {
        current += inner[i + 1];
        i++;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      current += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      current += ch;
      continue;
    }
    if (ch === ",") {
      items.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") items.push(current.trim());
  return items;
}

/**
 * @param {string} rawValue the trimmed text after `key:` (or a sequence item)
 * @param {number} lineNo
 * @returns {unknown}
 */
function parseScalarOrFlow(rawValue, lineNo) {
  if (rawValue === "{}") return {};
  if (rawValue === "[]") return [];
  if (rawValue.startsWith("[")) {
    if (!rawValue.endsWith("]")) throw new YamlSubsetError(`malformed flow sequence at line ${lineNo}`);
    const inner = rawValue.slice(1, -1).trim();
    if (inner === "") return [];
    return splitFlowItems(inner).map((item) => parseScalar(item, lineNo));
  }
  return parseScalar(rawValue, lineNo);
}

/**
 * Consumes a literal block scalar's content starting at raw line `start`
 * (the line right after the `key: |` line), stopping at the first line
 * whose indentation is at or above `keyIndent`. Blank lines are always part
 * of the block; comment markers inside it are literal text, never comments.
 * @param {string[]} rawLines
 * @param {number} start
 * @param {number} keyIndent
 * @param {"clip" | "strip"} chomp
 * @returns {{ value: string, next: number }}
 */
function consumeBlockScalar(rawLines, start, keyIndent, chomp) {
  const collected = [];
  let end = start;
  while (end < rawLines.length) {
    const line = rawLines[end];
    if (line.trim() === "") {
      collected.push({ blank: true });
      end++;
      continue;
    }
    const leadingSpaces = line.match(/^ */)[0].length;
    if (leadingSpaces <= keyIndent) break;
    collected.push({ blank: false, indent: leadingSpaces, text: line });
    end++;
  }
  const firstContent = collected.find((entry) => !entry.blank);
  const contentIndent = firstContent ? firstContent.indent : keyIndent + 1;
  const textLines = collected.map((entry) =>
    entry.blank ? "" : entry.text.length >= contentIndent ? entry.text.slice(contentIndent) : entry.text.slice(entry.indent),
  );
  let lastNonBlank = textLines.length - 1;
  while (lastNonBlank >= 0 && textLines[lastNonBlank] === "") lastNonBlank--;
  const trimmed = textLines.slice(0, lastNonBlank + 1);
  let value = trimmed.join("\n");
  if (trimmed.length > 0) value += chomp === "strip" ? "" : "\n";
  return { value, next: end };
}

/**
 * Reads one mapping value and continues over further keys at `indent`,
 * starting from an already-parsed first entry. Shared by a plain mapping
 * block and a mapping that begins inline after a sequence dash.
 * @param {string[]} rawLines
 * @param {number} indent
 * @param {string} firstKey
 * @param {string} firstRawValue
 * @param {number} firstLineNo
 * @param {number} startIdx raw index to resume scanning from for the first entry's value
 * @returns {{ value: Record<string, unknown>, next: number }}
 */
function consumeMapping(rawLines, indent, firstKey, firstRawValue, firstLineNo, startIdx, ctx = null) {
  const result = {};
  const seen = new Set();
  let key = firstKey;
  let rawValue = firstRawValue;
  let lineNo = firstLineNo;
  let idx = startIdx;
  for (;;) {
    if (seen.has(key)) throw new YamlSubsetError(`duplicate key "${key}" at line ${lineNo}`);
    seen.add(key);
    let afterIdx;
    if (rawValue === "") {
      if (idx < rawLines.length) {
        const child = lineInfo(rawLines, idx);
        if (child.indent > indent) {
          const parsed = parseNode(rawLines, idx, child.indent, ctx);
          result[key] = parsed.value;
          afterIdx = nextSignificant(rawLines, parsed.next);
        } else if (child.indent === indent && isSeqItem(child.content)) {
          const parsed = consumeSequence(rawLines, indent, child.content, child.lineNo, nextSignificant(rawLines, idx + 1), ctx);
          result[key] = parsed.value;
          afterIdx = nextSignificant(rawLines, parsed.next);
        } else {
          result[key] = null;
          afterIdx = idx;
        }
      } else {
        result[key] = null;
        afterIdx = idx;
      }
    } else if (rawValue === "|" || rawValue === "|-") {
      const { value, next } = consumeBlockScalar(rawLines, idx, indent, rawValue === "|-" ? "strip" : "clip");
      result[key] = value;
      afterIdx = nextSignificant(rawLines, next);
    } else {
      result[key] = parseScalarOrFlow(rawValue, lineNo);
      afterIdx = idx;
    }
    if (ctx && ctx.keySet.has(key)) ctx.sink.push({ key, value: result[key], line: lineNo });
    if (afterIdx >= rawLines.length) return { value: result, next: afterIdx };
    const peek = lineInfo(rawLines, afterIdx);
    if (peek.indent !== indent || isSeqItem(peek.content) || (indent === 0 && isDocumentSeparator(peek.content))) {
      return { value: result, next: afterIdx };
    }
    ({ key, rawValue } = splitMappingLine(peek.content, peek.lineNo));
    lineNo = peek.lineNo;
    idx = nextSignificant(rawLines, afterIdx + 1);
  }
}

/**
 * @param {string} content a full sequence-item line's content, e.g. `- foo` or `-`
 * @returns {{ itemContent: string, leadingSpaces: number }}
 */
function stripDash(content) {
  const rest = content.slice(1);
  const leadingSpaces = rest.match(/^\s*/)[0].length;
  return { itemContent: rest.slice(leadingSpaces), leadingSpaces };
}

/**
 * Reads a sequence's items, starting from an already-identified first item
 * line's content.
 * @param {string[]} rawLines
 * @param {number} indent
 * @param {string} initialContent
 * @param {number} initialLineNo
 * @param {number} startIdx
 * @returns {{ value: unknown[], next: number }}
 */
function consumeSequence(rawLines, indent, initialContent, initialLineNo, startIdx, ctx = null) {
  const items = [];
  let content = initialContent;
  let lineNo = initialLineNo;
  let idx = startIdx;
  for (;;) {
    const { itemContent, leadingSpaces } = stripDash(content);
    let afterIdx;
    if (itemContent === "") {
      if (idx < rawLines.length) {
        const child = lineInfo(rawLines, idx);
        if (child.indent > indent) {
          const parsed = parseNode(rawLines, idx, child.indent, ctx);
          items.push(parsed.value);
          afterIdx = nextSignificant(rawLines, parsed.next);
        } else {
          items.push(null);
          afterIdx = idx;
        }
      } else {
        items.push(null);
        afterIdx = idx;
      }
    } else {
      const contentIndent = indent + 1 + leadingSpaces;
      if (isSeqItem(itemContent)) {
        const parsed = consumeSequence(rawLines, contentIndent, itemContent, lineNo, idx, ctx);
        items.push(parsed.value);
        afterIdx = nextSignificant(rawLines, parsed.next);
      } else if (looksLikeMappingKey(itemContent)) {
        const { key, rawValue } = splitMappingLine(itemContent, lineNo);
        const parsed = consumeMapping(rawLines, contentIndent, key, rawValue, lineNo, idx, ctx);
        items.push(parsed.value);
        afterIdx = nextSignificant(rawLines, parsed.next);
      } else {
        items.push(parseScalarOrFlow(itemContent, lineNo));
        afterIdx = idx;
      }
    }
    if (afterIdx >= rawLines.length) return { value: items, next: afterIdx };
    const peek = lineInfo(rawLines, afterIdx);
    if (peek.indent !== indent || !isSeqItem(peek.content) || (indent === 0 && isDocumentSeparator(peek.content))) {
      return { value: items, next: afterIdx };
    }
    content = peek.content;
    lineNo = peek.lineNo;
    idx = nextSignificant(rawLines, afterIdx + 1);
  }
}

/**
 * @param {string[]} rawLines
 * @param {number} i index of a significant line at `indent`
 * @param {number} indent
 * @returns {{ value: unknown, next: number }}
 */
function parseNode(rawLines, i, indent, ctx = null) {
  const info = lineInfo(rawLines, i);
  if (isSeqItem(info.content)) {
    const startIdx = nextSignificant(rawLines, i + 1);
    return consumeSequence(rawLines, indent, info.content, info.lineNo, startIdx, ctx);
  }
  if (looksLikeMappingKey(info.content)) {
    const { key, rawValue } = splitMappingLine(info.content, info.lineNo);
    const startIdx = nextSignificant(rawLines, i + 1);
    return consumeMapping(rawLines, indent, key, rawValue, info.lineNo, startIdx, ctx);
  }
  return { value: parseScalarOrFlow(info.content, info.lineNo), next: nextSignificant(rawLines, i + 1) };
}

/**
 * @param {string} content
 * @returns {boolean}
 */
function isDocumentSeparator(content) {
  return content === "---";
}

/**
 * Parses one document, optionally recording every occurrence of a key in
 * `ctx.keySet` (at any depth, in any mapping) into `ctx.sink`. Shared by
 * `parseYaml` (no `ctx`, returns the parsed value) and `findKeyOccurrences`
 * (returns only the recorded occurrences), so both see exactly the same
 * refusals for anything outside the supported subset.
 * @param {string} text
 * @param {{ keySet: Set<string>, sink: { key: string, value: unknown, line: number }[] } | null} ctx
 * @returns {unknown} the parsed value; `null` for an empty document
 */
function parseDocument(text, ctx) {
  const rawLines = splitLines(text);
  let i = nextSignificant(rawLines, 0);
  if (i >= rawLines.length) return null;
  let info = lineInfo(rawLines, i);
  if (info.indent === 0 && isDocumentSeparator(info.content)) {
    i = nextSignificant(rawLines, i + 1);
    if (i >= rawLines.length) return null;
    info = lineInfo(rawLines, i);
  }
  const { value, next } = parseNode(rawLines, i, info.indent, ctx);
  const after = nextSignificant(rawLines, next);
  if (after < rawLines.length) {
    const trailing = lineInfo(rawLines, after);
    if (trailing.indent === 0 && isDocumentSeparator(trailing.content)) {
      throw new YamlSubsetError(`multiple documents are not supported (second at line ${trailing.lineNo})`);
    }
    throw new YamlSubsetError(`unexpected content at line ${trailing.lineNo}`);
  }
  return value;
}

/**
 * @param {string} text
 * @returns {unknown} the parsed value; `null` for an empty document
 */
export function parseYaml(text) {
  return parseDocument(text, null);
}

/**
 * Walks the whole parsed document and returns every occurrence of any key
 * named in `keyNames`, at any depth in any mapping (including a mapping
 * that begins inline inside a sequence item), each with the value the
 * reader parsed for it and the line its key appeared on. Refuses (throws
 * `YamlSubsetError`) exactly where `parseYaml` would: an anchor, alias, tag,
 * folded scalar, non-empty flow mapping, second document, duplicate key or
 * tab in indentation anywhere in the file, even far from any occurrence of
 * `keyNames` -- a construct this reader cannot represent might be hiding a
 * matching key's real value, so the whole document is refused rather than
 * silently walked around.
 * @param {string} text
 * @param {string[]} keyNames
 * @returns {{ key: string, value: unknown, line: number }[]}
 */
export function findKeyOccurrences(text, keyNames) {
  const ctx = { keySet: new Set(keyNames), sink: [] };
  parseDocument(text, ctx);
  return ctx.sink;
}
