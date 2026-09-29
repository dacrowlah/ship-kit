// Release-tag parsing shared by the review plan (the release-pin check) and
// setup (pin resolution). Input is `git ls-remote` output: one
// "<40 hex>\t<ref>" line per ref, where an annotated tag has a second line
// "<40 hex>\t<ref>^{}" carrying the commit it peels to. Only refs under
// refs/tags/ whose name is a release tag (`ship-kit--v<semver>` or
// `ship-kit--v<semver>-rc.<n>`, n >= 1) are kept; any line that is not in
// that shape, or a ref listed twice, throws, so a listing this parser cannot
// read is refused rather than half-read.

export const RELEASE_TAG = /^ship-kit--v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-rc\.[1-9]\d*)?$/;

const LINE = /^([0-9a-f]{40})\t(\S+)$/;
const TAG_PREFIX = "refs/tags/";
const PEEL = "^{}";

/**
 * @param {string} text `git ls-remote` output (LF or CRLF line endings)
 * @returns {Map<string, { commit: string, annotated: boolean }>}
 */
export function parseLsRemote(text) {
  if (typeof text !== "string") throw new TypeError("ls-remote output must be a string");
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const tagLines = new Map();
  const peelLines = new Map();
  for (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const match = LINE.exec(line);
    if (!match) throw new Error(`malformed ls-remote line: ${JSON.stringify(line)}`);
    const [, sha, ref] = match;
    if (!ref.startsWith(TAG_PREFIX)) continue;
    const peeled = ref.endsWith(PEEL);
    const name = ref.slice(TAG_PREFIX.length, peeled ? -PEEL.length : undefined);
    if (!RELEASE_TAG.test(name)) continue;
    const seen = peeled ? peelLines : tagLines;
    if (seen.has(name)) throw new Error(`duplicate ls-remote line for ${ref}`);
    seen.set(name, sha);
  }
  const tags = new Map();
  for (const [name, sha] of tagLines) {
    const commit = peelLines.get(name);
    tags.set(name, commit === undefined ? { commit: sha, annotated: false } : { commit, annotated: true });
  }
  for (const name of peelLines.keys()) {
    if (!tagLines.has(name)) throw new Error(`peeled line without its tag line: ${name}`);
  }
  return tags;
}

function rank(name) {
  const [, major, minor, patch, rc] = RELEASE_TAG.exec(name);
  // BigInt keeps components beyond 2^53 exact. A final release sorts above
  // every rc of the same version.
  const final = rc === undefined ? 1n : 0n;
  const rcNumber = rc === undefined ? 0n : BigInt(rc.slice("-rc.".length));
  return [BigInt(major), BigInt(minor), BigInt(patch), final, rcNumber];
}

function compareRankDesc(a, b) {
  const ra = rank(a);
  const rb = rank(b);
  // Distinct tag names never rank equal, so some component differs.
  const i = ra.findIndex((value, k) => value !== rb[k]);
  return ra[i] > rb[i] ? -1 : 1;
}

/**
 * The release tag whose peeled commit is `sha`. For an annotated tag only
 * its `^{}` commit counts, never the tag object's own SHA. When several tags
 * peel to the same commit (an rc and the final release it became), the
 * highest version wins and a final release beats its rcs.
 * @param {Map<string, { commit: string, annotated: boolean }>} tags from parseLsRemote
 * @param {string} sha
 * @returns {string | null}
 */
export function releaseTagFor(tags, sha) {
  const matches = [];
  for (const [name, { commit }] of tags) {
    if (commit === sha) matches.push(name);
  }
  if (matches.length === 0) return null;
  return matches.sort(compareRankDesc)[0];
}
