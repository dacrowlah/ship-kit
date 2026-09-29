// Review modes, the seat output schemas, severity classification and the
// design-doc review base. Pure functions only: no filesystem, network or
// git access. Callers (plan.mjs, aggregate.mjs, trust-state.mjs) supply
// already-trusted inputs (5.3 config, decoded and trust-checked state
// markers, a real `git merge-base --is-ancestor` wrapper).

export const FULL = "full";
export const DESIGN_DOC = "design-doc";
export const BLOCKING = "BLOCKING";
export const NON_BLOCKING = "NON-BLOCKING";

export const SEATS = ["general", "adversarial", "security", "test-integrity"];

export const SEAT_SKILLS = {
  general: "reviewing-for-correctness",
  adversarial: "hunting-defect-shapes",
  security: "reviewing-security",
  "test-integrity": "reviewing-test-integrity",
};

/**
 * Design-doc mode when the PR changes at least one file and every changed
 * path starts with one of `dirs`; full mode otherwise (including an empty
 * diff, or no dirs configured).
 * @param {string[]} paths changed paths (both sides of every rename)
 * @param {string[]} dirs configured spec/plan directories; each must end "/"
 * @returns {"full"|"design-doc"}
 */
export function classifyMode(paths, dirs) {
  if (!Array.isArray(dirs)) {
    throw new TypeError(`dirs must be an array: ${JSON.stringify(dirs)}`);
  }
  for (const dir of dirs) {
    if (typeof dir !== "string" || !dir.endsWith("/")) {
      throw new TypeError(`each dir must end with "/": ${JSON.stringify(dir)}`);
    }
  }
  if (paths.length === 0 || dirs.length === 0) return FULL;
  const allUnderDirs = paths.every((path) => dirs.some((dir) => path.startsWith(dir)));
  return allUnderDirs ? DESIGN_DOC : FULL;
}

const BASE_PROPERTIES = {
  verdict: { type: "string", enum: ["PASS", "FAIL"] },
  complete: { type: "boolean" },
  unreviewed: { type: "array", items: { type: "string" } },
  summary: { type: "string" },
  contract_nonce: { type: "string", pattern: "^[0-9a-f]{32}$" },
  skill_marker: { type: "string" },
};

const FINDING_SCHEMA = {
  type: "object",
  properties: {
    severity: { type: "string" },
    file: { type: "string" },
    line: { type: "integer", minimum: 0 },
    finding: { type: "string" },
  },
  required: ["severity", "file", "line", "finding"],
  additionalProperties: false,
};

const PRIOR_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    status: { type: "string", enum: ["RESOLVED", "UNRESOLVED"] },
    note: { type: "string" },
  },
  required: ["id", "status", "note"],
  additionalProperties: false,
};

/**
 * @param {"full"|"design-doc"} mode
 * @returns {string} the JSON Schema for a seat's output in this mode, as a
 *   JSON string containing no single-quote character (it is passed as a
 *   single-quoted shell word)
 */
export function schemaFor(mode) {
  if (mode !== FULL && mode !== DESIGN_DOC) {
    throw new TypeError(`unknown mode: ${JSON.stringify(mode)}`);
  }
  const properties = { ...BASE_PROPERTIES };
  if (mode === DESIGN_DOC) {
    properties.findings = { type: "array", items: FINDING_SCHEMA };
    properties.prior = { type: "array", items: PRIOR_SCHEMA };
  }
  const schema = {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
  return JSON.stringify(schema);
}

/**
 * Anything other than the explicit literal "NON-BLOCKING" is blocking
 * (design 8.3).
 * @param {unknown} severity
 * @returns {"BLOCKING"|"NON-BLOCKING"}
 */
export function severityOf(severity) {
  return severity === NON_BLOCKING ? NON_BLOCKING : BLOCKING;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Coerces an arbitrary value into a well-formed finding. Every field fails
 * closed to a safe default rather than propagating a malformed shape.
 * @param {unknown} f
 * @returns {{severity: "BLOCKING"|"NON-BLOCKING", file: string, line: number, finding: string}}
 */
export function normalizeFinding(f) {
  const source = isPlainObject(f) ? f : {};
  return {
    severity: severityOf(source.severity),
    file: typeof source.file === "string" ? source.file : "",
    line: Number.isSafeInteger(source.line) && source.line >= 0 ? source.line : 0,
    finding: typeof source.finding === "string" ? source.finding : "",
  };
}

/**
 * Picks the review base among trusted, complete states of `kind`: the
 * newest whose head is an ancestor of the current head, ancestry-ordered,
 * with comment order (the states array's own order, ascending by comment
 * id) breaking ties ancestry cannot order.
 * @param {object[]} states decoded, already-trusted state markers, ascending comment id
 * @param {string} kind the seat name
 * @param {{head: string, isAncestor: (candidate: string, head: string) => boolean}} deps
 * @returns {object|null} the winning state, or null if none qualify
 */
export function findReviewBase(states, kind, { head, isAncestor }) {
  const safeIsAncestor = (candidate, of) => {
    if (candidate === of) return true;
    try {
      return Boolean(isAncestor(candidate, of));
    } catch {
      return false;
    }
  };

  const candidates = states
    .map((state, index) => ({ state, index }))
    .filter(({ state }) => state.kind === kind && state.complete === true)
    .filter(({ state }) => safeIsAncestor(state.head, head));

  if (candidates.length === 0) return null;

  let best = candidates[0];
  for (let i = 1; i < candidates.length; i += 1) {
    const cur = candidates[i];
    if (safeIsAncestor(best.state.head, cur.state.head)) {
      best = cur;
    } else if (safeIsAncestor(cur.state.head, best.state.head)) {
      // cur is an ancestor of (older than) best: keep best.
    } else if (cur.index > best.index) {
      best = cur;
    }
  }
  return best.state;
}

const MARKER_PREFIX = "skill_marker:";

/**
 * @param {string} skillText a SKILL.md body
 * @returns {string|null} the single "skill_marker: ..." line, or null if
 *   there is none or more than one
 */
export function markerLine(skillText) {
  const lines = skillText.split("\n").map((line) => line.replace(/\r$/, ""));
  const matches = lines.filter((line) => line.startsWith(MARKER_PREFIX));
  return matches.length === 1 ? matches[0] : null;
}
