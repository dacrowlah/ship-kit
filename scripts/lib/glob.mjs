// Matches repo-relative POSIX paths against glob patterns. `*` and `?`
// never cross `/`; `**` as a whole segment matches zero or more segments
// (one or more when it is the last segment). Every other character,
// including `[`, `{` and regex metacharacters, is literal. Dotfiles are
// not special.
//
// globToRegExp returns the equivalent RegExp. matchGlob and matchAny never
// run it: a backtracking RegExp built from a star-heavy pattern can take
// exponential time, so they match segment by segment in time bounded by
// pattern length times path length.

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

// Collapses runs of consecutive whole "**" segments into one. This keeps
// the RegExp's meaning: two inner "**" (each zero or more segments) read
// as one, and an inner "**" before the last "**" (one or more segments)
// reads as the last "**" alone.
function dedupeStarSegments(segments) {
  const out = [];
  for (const segment of segments) {
    if (segment === "**" && out[out.length - 1] === "**") continue;
    out.push(segment);
  }
  return out;
}

/** @param {string} pattern @returns {RegExp} */
export function globToRegExp(pattern) {
  assertRelative(pattern, "pattern");
  const segments = dedupeStarSegments(pattern.split("/"));
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

// Matches one path segment (no "/") against one pattern segment (no "/",
// and never the literal "**", which is handled a level up) using the
// standard iterative wildcard algorithm: `*` matches greedily, backtracking
// only to the position of the last unresolved `*`. O(pattern.length *
// text.length) worst case; never exponential, unlike a backtracking RegExp
// built from the same pattern.
function matchOneSegment(pattern, text) {
  let pi = 0;
  let ti = 0;
  let starPi = -1;
  let starTi = 0;
  while (ti < text.length) {
    if (pi < pattern.length && pattern[pi] !== "*" && (pattern[pi] === "?" || pattern[pi] === text[ti])) {
      pi++;
      ti++;
    } else if (pi < pattern.length && pattern[pi] === "*") {
      starPi = pi;
      starTi = ti;
      pi++;
    } else if (starPi !== -1) {
      pi = starPi + 1;
      starTi++;
      ti = starTi;
    } else {
      return false;
    }
  }
  while (pi < pattern.length && pattern[pi] === "*") pi++;
  return pi === pattern.length;
}

// Matches path segments against pattern segments, with the meaning of the
// RegExp globToRegExp builds:
// - an inner "**" matches zero or more non-empty path segments, each
//   followed by "/", so it never takes the path's last segment;
// - the last "**" matches all remaining path segments, which must be one
//   or more, all non-empty;
// - any other pattern segment matches exactly one path segment, and an
//   inner one needs a following path segment.
// canMatch[si] says whether pattern segments pi.. match path segments si..;
// filling it from the last pattern segment back visits each (pi, si) pair
// once.
function matchSegments(patternSegments, pathSegments) {
  const n = pathSegments.length;
  const lastPi = patternSegments.length - 1;
  const restNonEmpty = new Array(n + 1).fill(true);
  for (let si = n - 1; si >= 0; si--) {
    restNonEmpty[si] = restNonEmpty[si + 1] && pathSegments[si] !== "";
  }

  let canMatch = new Array(n).fill(false);
  for (let si = 0; si < n; si++) {
    canMatch[si] =
      patternSegments[lastPi] === "**"
        ? restNonEmpty[si]
        : si === n - 1 && matchOneSegment(patternSegments[lastPi], pathSegments[si]);
  }
  for (let pi = lastPi - 1; pi >= 0; pi--) {
    const next = canMatch;
    canMatch = new Array(n).fill(false);
    const segment = patternSegments[pi];
    for (let si = n - 1; si >= 0; si--) {
      if (segment === "**") {
        canMatch[si] = next[si] || (si + 1 < n && pathSegments[si] !== "" && canMatch[si + 1]);
      } else {
        canMatch[si] = si + 1 < n && next[si + 1] && matchOneSegment(segment, pathSegments[si]);
      }
    }
  }
  return canMatch[0];
}

function matchesPattern(path, pattern) {
  assertRelative(pattern, "pattern");
  return matchSegments(pattern.split("/"), path.split("/"));
}

/** @param {string} path @param {string} pattern @returns {boolean} */
export function matchGlob(path, pattern) {
  assertRelative(path, "path");
  return matchesPattern(path, pattern);
}

/** @param {string} path @param {readonly string[]} patterns @returns {boolean} */
export function matchAny(path, patterns) {
  assertRelative(path, "path");
  return patterns.some((pattern) => matchesPattern(path, pattern));
}
