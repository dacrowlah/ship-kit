// Splits a diff's files into review seats, and computes the incremental
// scope and prior-finding assignment for design-doc mode (design 6.3 plan
// step 4, 8.2). Pure functions only: no filesystem, network or git access.
// Callers supply already-trusted inputs and real git wrappers
// (`isAncestor`, `changedFiles`).

import { DESIGN_DOC, BLOCKING, normalizeFinding } from "./review-mode.mjs";

const HEX40 = /^[0-9a-f]{40}$/i;

function isHex40(value) {
  return typeof value === "string" && HEX40.test(value);
}

function weightOf(file) {
  return Number.isFinite(file.weight) ? file.weight : 0;
}

/**
 * Splits `files` into seats, greedy longest-first into the lightest seat.
 * The seat count is `max(1, min(maxSeats, files.length, ceil(total/targetLines)))`,
 * so it never exceeds the number of files and a seat is never left empty.
 * Ties for "lightest" (equal running total) are broken by fewest files
 * already assigned, then by lowest seat index, so seats fill round-robin
 * before any seat gets a second file even when many files carry the same
 * weight (including zero).
 * @param {{path: string, weight: number}[]} files
 * @param {{maxSeats: number, targetLines: number}} options
 * @returns {{path: string, weight: number}[][]}
 */
export function partition(files, { maxSeats, targetLines }) {
  if (!Array.isArray(files)) {
    throw new TypeError(`files must be an array: ${JSON.stringify(files)}`);
  }
  if (files.length === 0) return [];

  const total = files.reduce((sum, file) => sum + weightOf(file), 0);
  const byLines = total === 0 ? 0 : Math.ceil(total / targetLines);
  const seatCount = Math.max(1, Math.min(maxSeats, files.length, byLines));

  const bins = Array.from({ length: seatCount }, () => []);
  const totals = new Array(seatCount).fill(0);
  const counts = new Array(seatCount).fill(0);

  const sorted = files
    .map((file, index) => ({ file, index }))
    .sort((a, b) => weightOf(b.file) - weightOf(a.file) || a.index - b.index);

  for (const { file } of sorted) {
    let lightest = 0;
    for (let i = 1; i < seatCount; i += 1) {
      if (
        totals[i] < totals[lightest]
        || (totals[i] === totals[lightest] && counts[i] < counts[lightest])
      ) {
        lightest = i;
      }
    }
    bins[lightest].push(file);
    totals[lightest] += weightOf(file);
    counts[lightest] += 1;
  }

  return bins;
}

/**
 * The full-scope result `planDesignDocScope` returns on any doubt: no
 * incremental restriction, and no carried-over prior findings.
 * @param {string} reason
 * @returns {{incremental: false, since: null, files: null, priors: [], reason: string}}
 */
export function fullScope(reason) {
  return { incremental: false, since: null, files: null, priors: [], reason };
}

/**
 * Decides whether a design-doc-mode PR can be reviewed incrementally
 * against its last trusted, complete state, or must fall back to a full
 * scope (design 8.2). Incremental only when the prior state was itself
 * design-doc mode, both merge bases are well-formed 40-hex commit SHAs,
 * the state's head is an ancestor of the current head, and the base branch
 * changed none of the PR's own files between the two merge bases. `files`
 * is then the set of paths changed since the state's head, restricted to
 * the PR's own files, so a file only touched by merging the base into the
 * PR branch is excluded. Any doubt -- a missing or wrong-mode state, an
 * invalid SHA, a throwing dependency, or a non-array result from it --
 * returns a full scope with a reason and no priors.
 * @param {object} args
 * @param {string[]} args.prFiles every path the PR itself touches
 * @param {object|null|undefined} args.state the review base found by
 *   `findReviewBase`, or nullish when there is none
 * @param {string} args.head the current PR head commit
 * @param {string} args.mergeBase the current merge-base commit with the
 *   base branch
 * @param {(candidate: string, of: string) => boolean} args.isAncestor
 * @param {(from: string, to: string) => string[]} args.changedFiles paths
 *   changed between two commits (either order argument is a real ref)
 * @returns {{incremental: boolean, since: string|null, files: string[]|null, priors: object[], reason: string|null}}
 */
export function planDesignDocScope({ prFiles, state, head, mergeBase, isAncestor, changedFiles }) {
  if (state === null || state === undefined || typeof state !== "object") {
    return fullScope("no prior state");
  }
  if (state.mode !== DESIGN_DOC) {
    return fullScope("prior state was not design-doc mode");
  }
  if (!isHex40(state.mergeBase) || !isHex40(mergeBase)) {
    return fullScope("merge base is not a well-formed commit SHA");
  }

  let ancestor;
  try {
    ancestor = Boolean(isAncestor(state.head, head));
  } catch {
    return fullScope("ancestry check failed");
  }
  if (!ancestor) {
    return fullScope("the prior state's head is not an ancestor of head");
  }

  const prFileSet = new Set(prFiles);

  let baseChanged;
  try {
    baseChanged = changedFiles(state.mergeBase, mergeBase);
  } catch {
    return fullScope("could not determine what the base branch changed");
  }
  if (!Array.isArray(baseChanged)) {
    return fullScope("could not determine what the base branch changed");
  }
  if (baseChanged.some((path) => prFileSet.has(path))) {
    return fullScope("the base branch moved under a file the PR touches");
  }

  let sinceFiles;
  try {
    sinceFiles = changedFiles(state.head, head);
  } catch {
    return fullScope("could not determine what changed since the prior review");
  }
  if (!Array.isArray(sinceFiles)) {
    return fullScope("could not determine what changed since the prior review");
  }

  return {
    incremental: true,
    since: state.head,
    files: sinceFiles.filter((path) => prFileSet.has(path)),
    priors: Array.isArray(state.findings) ? state.findings : [],
    reason: null,
  };
}

/**
 * Assigns each prior finding an id and the seat that should re-check it:
 * the seat holding the finding's file, else the lightest seat by total
 * weight (ties broken by lowest index); `null` when there are no seats.
 * @param {object[]} priors raw prior findings (design-doc `findings[]` shape)
 * @param {{path: string, weight: number}[][]} bins the partition's seats
 * @returns {{id: string, seat: number|null}[]}
 */
export function assignPriors(priors, bins) {
  return priors.map((prior, index) => {
    const normalized = normalizeFinding(prior);
    let seat = null;
    if (bins.length > 0) {
      const holder = bins.findIndex((bin) => bin.some((file) => file.path === normalized.file));
      if (holder !== -1) {
        seat = holder;
      } else {
        let lightest = 0;
        let lightestWeight = bins[0].reduce((sum, file) => sum + weightOf(file), 0);
        for (let i = 1; i < bins.length; i += 1) {
          const weight = bins[i].reduce((sum, file) => sum + weightOf(file), 0);
          if (weight < lightestWeight) {
            lightest = i;
            lightestWeight = weight;
          }
        }
        seat = lightest;
      }
    }
    return { id: `p${index + 1}`, seat, ...normalized };
  });
}

/**
 * True when the scope has no changed paths to review yet a BLOCKING prior
 * is still open, so one seat must run anyway with an empty chunk to
 * re-check it (design 8.2).
 * @param {string[]} reviewPaths the scope's changed paths
 * @param {{severity: string}[]} priors already-normalized prior findings
 * @returns {boolean}
 */
export function needsPriorCheck(reviewPaths, priors) {
  return reviewPaths.length === 0 && priors.some((prior) => prior.severity === BLOCKING);
}
