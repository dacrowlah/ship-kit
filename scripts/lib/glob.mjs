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
