// Matches repo-relative POSIX paths against glob patterns. `*` and `?`
// never cross `/`; `**` as a whole segment matches zero or more segments
// (one or more when it is the last segment). Every other character,
// including `[`, `{` and regex metacharacters, is literal. Dotfiles are
// not special.
//
// matchGlob/matchAny match through a segment-wise, backtrack-to-the-last-
// star algorithm (bounded polynomial time) instead of driving a single
// backtracking RegExp: a naive multi-wildcard regex can blow up
// exponentially on adversarial input (many non-adjacent `*` inside one
// segment, or many `**` segments), which a synchronous matcher on a
// merge-gating path cannot afford.

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

// Collapses runs of consecutive whole "**" segments into one: they are
// semantically identical ("zero or more segments", repeated), and leaving
// them uncollapsed is a cheap way for a caller to blow up matcher work
// (each occurrence would otherwise contribute its own choice point).
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

// Matches path segments against pattern segments. A whole "**" segment
// matches zero or more path segments, backtracking only to the position of
// the last unresolved "**" -- the same shape as matchOneSegment, one level
// up, so the total cost stays bounded even when many "**" segments are
// present. The pattern's *trailing* "**" segment is the one exception: it
// must consume at least one path segment (matched by checking a minimum
// path length up front, rather than by special-casing the walk itself).
function matchSegments(patternSegments, pathSegments) {
  const nonStarCount = patternSegments.reduce((count, segment) => (segment === "**" ? count : count + 1), 0);
  const lastIsStar = patternSegments[patternSegments.length - 1] === "**";
  if (lastIsStar && pathSegments.length < nonStarCount + 1) {
    return false;
  }

  let pi = 0;
  let si = 0;
  let starPi = -1;
  let starSi = 0;
  while (si < pathSegments.length) {
    const atStar = pi < patternSegments.length && patternSegments[pi] === "**";
    if (pi < patternSegments.length && !atStar && matchOneSegment(patternSegments[pi], pathSegments[si])) {
      pi++;
      si++;
    } else if (atStar) {
      starPi = pi;
      starSi = si;
      pi++;
    } else if (starPi !== -1) {
      pi = starPi + 1;
      starSi++;
      si = starSi;
    } else {
      return false;
    }
  }
  while (pi < patternSegments.length && patternSegments[pi] === "**") pi++;
  return pi === patternSegments.length;
}

function matchesPattern(path, pattern) {
  assertRelative(pattern, "pattern");
  const patternSegments = dedupeStarSegments(pattern.split("/"));
  const pathSegments = path.split("/");
  return matchSegments(patternSegments, pathSegments);
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
