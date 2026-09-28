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
