// The author rule: whether a pull request's seats may run, or the run stops
// with `needs-maintainer`. Seats run only when the event's sender (the
// account whose event started the run; a re-run keeps it) has at least
// write permission, and either the PR comes from this repository and its
// author has at least write, or a maintainer approved the current head with
// an unedited issue comment `/ship-kit-review <full head sha>`.
//
// Every input that is missing, malformed or unreadable counts against
// running: a permission read that fails is "none", an unknown permission
// value is "none", a comment without an author or timestamps is ignored.

import { api, repoSlug } from "../lib/gh.mjs";

export const PERMISSION_RANK = Object.freeze({ none: 0, read: 1, triage: 2, write: 3, maintain: 4, admin: 5 });

const APPROVAL = /^\/ship-kit-review ([0-9a-fA-F]{40})$/;
const SHA = /^[0-9a-fA-F]{40}$/;

function rankOf(permission) {
  return typeof permission === "string" && Object.hasOwn(PERMISSION_RANK, permission)
    ? PERMISSION_RANK[permission]
    : null;
}

/**
 * @param {unknown} permission a value read from the API; unknown ranks below everything
 * @param {string} minimum a key of PERMISSION_RANK
 * @returns {boolean}
 */
export function atLeast(permission, minimum) {
  const floor = rankOf(minimum);
  if (floor === null) throw new TypeError(`unknown minimum permission: ${JSON.stringify(minimum)}`);
  const rank = rankOf(permission);
  return rank !== null && rank >= floor;
}

/**
 * @param {unknown} user a login string, or a GitHub user object `{login, type}`
 * @returns {boolean} true for a bot, and for anything that is not a usable user
 */
export function isBot(user) {
  const login = typeof user === "string" ? user : user && typeof user === "object" ? user.login : undefined;
  if (typeof login !== "string" || login === "") return true;
  if (login.toLowerCase().endsWith("[bot]")) return true;
  return typeof user === "object" && user.type === "Bot";
}

/**
 * The approved SHA of a comment body: the whole body, trimmed, must be the
 * single line `/ship-kit-review <40 hex>`.
 * @param {unknown} body
 * @returns {string | null} the lower-cased SHA
 */
export function parseApproval(body) {
  if (typeof body !== "string") return null;
  const text = body.trim();
  if (text.includes("\n") || text.includes("\r")) return null;
  const match = APPROVAL.exec(text);
  return match ? match[1].toLowerCase() : null;
}

/**
 * @param {{gh: {get: (path: string) => {status: number, json: unknown}}, repo: string}} options
 * @returns {(login: unknown) => string} a permission name, "none" on any failure; cached per login
 */
export function makePermissionOf({ gh, repo }) {
  const { owner, name } = repoSlug(repo);
  if (!gh || typeof gh.get !== "function") throw new TypeError("gh must provide get()");
  const cache = new Map();

  function read(login) {
    try {
      const { status, json } = gh.get(api`repos/${owner}/${name}/collaborators/${login}/permission`);
      if (status !== 200 || json === null || typeof json !== "object") return "none";
      const value = json.role_name != null ? json.role_name : json.permission;
      return rankOf(value) === null ? "none" : value;
    } catch {
      return "none";
    }
  }

  return (login) => {
    if (typeof login !== "string") return "none";
    if (!cache.has(login)) cache.set(login, read(login));
    return cache.get(login);
  };
}

function requireSha(headSha) {
  if (typeof headSha !== "string" || !SHA.test(headSha)) {
    throw new TypeError(`head SHA must be 40 hex characters: ${JSON.stringify(headSha)}`);
  }
  return headSha.toLowerCase();
}

/**
 * The reason a run stops with `needs-maintainer`, naming the full head SHA
 * to paste into an approval.
 * @param {string} headSha
 * @returns {string}
 */
export function needsMaintainerText(headSha) {
  const sha = requireSha(headSha);
  return [
    "This PR comes from a fork or from an author without write access, or its last event was sent by one. "
      + "A maintainer who has read the diff comments `/ship-kit-review <full head sha>` and then closes and "
      + "reopens the PR; the reopen runs the review with the maintainer as sender. "
      + "A PR that cannot be reopened can be converted to draft and marked ready for review instead; "
      + "that event also runs the review.",
    "",
    `Full head SHA: ${sha}`,
  ].join("\n");
}

function unedited(comment) {
  const { created_at: created, updated_at: updated } = comment;
  return typeof created === "string" && created !== "" && created === updated;
}

function hasPermission(permissionOf, login, minimum) {
  try {
    return atLeast(permissionOf(login), minimum);
  } catch {
    return false;
  }
}

/**
 * @param {{
 *   sender: unknown, prAuthor: unknown, headRepo: string | null, repo: string,
 *   headSha: string, comments: unknown[], minApprover: string,
 *   permissionOf: (login: string) => string,
 * }} input `sender` is the event's actor, `prAuthor` the PR author's login,
 *   `headRepo` the head repository's full name (null for a deleted fork),
 *   `comments` every issue comment on the PR
 * @returns {{run: true, basis: "writer-pr" | "approved"} | {run: false, status: "needs-maintainer", reason: string}}
 */
export function decideAuthor({ sender, prAuthor, headRepo, repo, headSha, comments, minApprover, permissionOf }) {
  const { slug } = repoSlug(repo);
  const head = requireSha(headSha);
  if (!atLeast(minApprover, "write")) {
    throw new TypeError(`minApprover must be write, maintain or admin: ${JSON.stringify(minApprover)}`);
  }
  if (!Array.isArray(comments)) throw new TypeError("comments must be an array");
  if (typeof permissionOf !== "function") throw new TypeError("permissionOf must be a function");
  if (headRepo !== null && typeof headRepo !== "string") throw new TypeError("headRepo must be a string or null");

  const refuse = { run: false, status: "needs-maintainer", reason: needsMaintainerText(head) };
  if (typeof sender !== "string" || isBot(sender) || !hasPermission(permissionOf, sender, "write")) return refuse;

  const sameRepo = headRepo !== null && headRepo.toLowerCase() === slug.toLowerCase();
  if (sameRepo && typeof prAuthor === "string" && hasPermission(permissionOf, prAuthor, "write")) {
    return { run: true, basis: "writer-pr" };
  }

  const approved = comments.some((comment) => comment !== null
    && typeof comment === "object"
    && parseApproval(comment.body) === head
    && unedited(comment)
    && comment.user !== null
    && typeof comment.user === "object"
    && !isBot(comment.user)
    && hasPermission(permissionOf, comment.user.login, minApprover));
  return approved ? { run: true, basis: "approved" } : refuse;
}
