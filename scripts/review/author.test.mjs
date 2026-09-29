import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { isolatedEnv } from "../assert-test-globs.mjs";
import { makeGh } from "../lib/gh.mjs";
import { included, makeFakeGhApi } from "../../tests/helpers/fake-gh-api.mjs";
import {
  PERMISSION_RANK, atLeast, decideAuthor, isBot, makePermissionOf, needsMaintainerText, parseApproval,
} from "./author.mjs";

const REPO = "acme/widgets";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OLD_HEAD = "fedcba9876543210fedcba9876543210fedcba98";
const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-01-01T00:05:00Z";

const PERMISSIONS = {
  writer: "write",
  maintainer: "maintain",
  owner: "admin",
  contributor: "read",
  triager: "triage",
  "helper[bot]": "write",
  "app-user": "write",
};
const lookup = (table = PERMISSIONS) => (login) => table[login] ?? "none";

function comment(body, login = "writer", extra = {}) {
  return { body, user: { login, type: "User" }, created_at: T0, updated_at: T0, ...extra };
}

/** Inputs for a fork PR by a contributor, opened by the contributor. */
function fork(overrides = {}) {
  return {
    sender: "contributor",
    prAuthor: "contributor",
    headRepo: "contributor/widgets",
    repo: REPO,
    headSha: HEAD,
    comments: [],
    minApprover: "write",
    permissionOf: lookup(),
    ...overrides,
  };
}

function assertRefused(result) {
  assert.equal(result.run, false);
  assert.equal(result.status, "needs-maintainer");
  assert.equal(result.reason, needsMaintainerText(HEAD));
}

/** A gh client whose `run` executes the scripted fake instead of `gh` on PATH. */
function ghWith(routes, options = {}) {
  const fake = makeFakeGhApi(routes);
  const run = (file, args, opts) => execFileSync(fake.bin, args, { ...opts, env: isolatedEnv() });
  return { gh: makeGh({ run, ...options }), fake };
}

function permissionRoute(login, status, body, extra = {}) {
  return {
    args: ["api", "--include", `repos/acme/widgets/collaborators/${login}/permission`],
    stdout: included(status, body),
    code: status === 200 ? 0 : 1,
    ...extra,
  };
}

// The eight cases of the design's author rule -----------------------------

test("a same-repository PR by a writer runs", () => {
  const result = decideAuthor(fork({ sender: "writer", prAuthor: "writer", headRepo: REPO }));
  assert.deepEqual(result, { run: true, basis: "writer-pr" });
});

test("a fork PR with no approval needs a maintainer", () => {
  assertRefused(decideAuthor(fork()));
});

test("an approval by a writer followed by a reopen from that writer runs", () => {
  const result = decideAuthor(fork({ sender: "writer", comments: [comment(`/ship-kit-review ${HEAD}`)] }));
  assert.deepEqual(result, { run: true, basis: "approved" });
});

test("the same approval on a re-run whose actor is the contributor needs a maintainer", () => {
  assertRefused(decideAuthor(fork({ sender: "contributor", comments: [comment(`/ship-kit-review ${HEAD}`)] })));
});

test("a 7-hex prefix of the head is rejected", () => {
  assert.equal(parseApproval(`/ship-kit-review ${HEAD.slice(0, 7)}`), null);
  assertRefused(decideAuthor(fork({ sender: "writer", comments: [comment(`/ship-kit-review ${HEAD.slice(0, 7)}`)] })));
});

test("a 39-hex prefix of the head is rejected", () => {
  assert.equal(parseApproval(`/ship-kit-review ${HEAD.slice(0, 39)}`), null);
  assertRefused(decideAuthor(fork({ sender: "writer", comments: [comment(`/ship-kit-review ${HEAD.slice(0, 39)}`)] })));
});

test("an approval for an older head is rejected", () => {
  assertRefused(decideAuthor(fork({ sender: "writer", comments: [comment(`/ship-kit-review ${OLD_HEAD}`)] })));
});

test("an edited approval is rejected", () => {
  const edited = comment(`/ship-kit-review ${HEAD}`, "writer", { updated_at: T1 });
  assertRefused(decideAuthor(fork({ sender: "writer", comments: [edited] })));
});

test("an approval by a login ending [bot] does not count, even with write", () => {
  const bot = comment(`/ship-kit-review ${HEAD}`, "helper[bot]");
  assertRefused(decideAuthor(fork({ sender: "writer", comments: [bot] })));
});

test("an approval by a user of type Bot does not count, even with write", () => {
  const bot = comment(`/ship-kit-review ${HEAD}`, "app-user", { user: { login: "app-user", type: "Bot" } });
  assertRefused(decideAuthor(fork({ sender: "writer", comments: [bot] })));
});

// Approval body parsing -----------------------------------------------------

test("a 41-hex body is rejected", () => {
  assert.equal(parseApproval(`/ship-kit-review ${HEAD}0`), null);
  assertRefused(decideAuthor(fork({ sender: "writer", comments: [comment(`/ship-kit-review ${HEAD}0`)] })));
});

test("an upper-case SHA equal to the head is accepted and returned lower-cased", () => {
  assert.equal(parseApproval(`/ship-kit-review ${HEAD.toUpperCase()}`), HEAD);
  const result = decideAuthor(fork({ sender: "writer", comments: [comment(`/ship-kit-review ${HEAD.toUpperCase()}`)] }));
  assert.deepEqual(result, { run: true, basis: "approved" });
});

test("an upper-case head SHA matches a lower-case approval", () => {
  const result = decideAuthor(fork({ sender: "writer", headSha: HEAD.toUpperCase(), comments: [comment(`/ship-kit-review ${HEAD}`)] }));
  assert.deepEqual(result, { run: true, basis: "approved" });
});

test("leading and trailing whitespace is accepted", () => {
  assert.equal(parseApproval(`  /ship-kit-review ${HEAD}  `), HEAD);
  assert.equal(parseApproval(`\n\t/ship-kit-review ${HEAD}\r\n`), HEAD);
  const result = decideAuthor(fork({ sender: "writer", comments: [comment(`  /ship-kit-review ${HEAD}\n`)] }));
  assert.deepEqual(result, { run: true, basis: "approved" });
});

test("a quoted approval is rejected", () => {
  assert.equal(parseApproval(`> /ship-kit-review ${HEAD}`), null);
  assertRefused(decideAuthor(fork({ sender: "writer", comments: [comment(`> /ship-kit-review ${HEAD}`)] })));
});

test("a two-line body with the approval on line 1 is rejected", () => {
  const body = `/ship-kit-review ${HEAD}\nlooks fine`;
  assert.equal(parseApproval(body), null);
  assertRefused(decideAuthor(fork({ sender: "writer", comments: [comment(body)] })));
});

test("a two-line body with the approval on line 2 is rejected", () => {
  assert.equal(parseApproval(`looks fine\n/ship-kit-review ${HEAD}`), null);
  assert.equal(parseApproval(`looks fine\r/ship-kit-review ${HEAD}`), null);
});

test("other near-misses are rejected", () => {
  for (const body of [
    `/ship-kit-review  ${HEAD}`,
    `/ship-kit-review\t${HEAD}`,
    `/Ship-Kit-Review ${HEAD}`,
    `ship-kit-review ${HEAD}`,
    `/ship-kit-review ${HEAD} please`,
    `/ship-kit-review ${HEAD.slice(0, 39)}g`,
    `\`/ship-kit-review ${HEAD}\``,
    "",
  ]) {
    assert.equal(parseApproval(body), null, JSON.stringify(body));
  }
  assert.equal(parseApproval(null), null);
  assert.equal(parseApproval(undefined), null);
  assert.equal(parseApproval(42), null);
});

// Approver checks -----------------------------------------------------------

test("an approver with triage does not count", () => {
  assertRefused(decideAuthor(fork({ sender: "writer", comments: [comment(`/ship-kit-review ${HEAD}`, "triager")] })));
});

test("minApprover admin rejects a maintain approver and accepts an admin one", () => {
  const byMaintainer = [comment(`/ship-kit-review ${HEAD}`, "maintainer")];
  assertRefused(decideAuthor(fork({ sender: "owner", minApprover: "admin", comments: byMaintainer })));
  const byOwner = [comment(`/ship-kit-review ${HEAD}`, "owner")];
  assert.deepEqual(decideAuthor(fork({ sender: "owner", minApprover: "admin", comments: byOwner })), { run: true, basis: "approved" });
});

test("a comment without a usable author, body or timestamps is ignored", () => {
  const good = `/ship-kit-review ${HEAD}`;
  for (const bad of [
    null,
    "a string",
    comment(good, "writer", { user: null }),
    comment(good, "writer", { user: "writer" }),
    comment(good, "writer", { user: { type: "User" } }),
    comment(good, "writer", { user: { login: "", type: "User" } }),
    comment(good, "writer", { created_at: undefined, updated_at: undefined }),
    comment(good, "writer", { created_at: "", updated_at: "" }),
    comment(good, "writer", { updated_at: undefined }),
    comment(good, "unknown-login"),
    { user: { login: "writer", type: "User" }, created_at: T0, updated_at: T0 },
  ]) {
    assertRefused(decideAuthor(fork({ sender: "writer", comments: [bad] })));
  }
});

test("one valid approval among invalid ones is found", () => {
  const comments = [
    comment(`/ship-kit-review ${OLD_HEAD}`),
    comment(`/ship-kit-review ${HEAD}`, "contributor"),
    comment(`/ship-kit-review ${HEAD}`, "maintainer"),
  ];
  assert.deepEqual(decideAuthor(fork({ sender: "writer", comments })), { run: true, basis: "approved" });
});

test("a permissionOf that throws for the approver counts as no permission", () => {
  const permissionOf = (login) => {
    if (login === "writer") return "write";
    throw new Error("boom");
  };
  const comments = [comment(`/ship-kit-review ${HEAD}`, "maintainer")];
  assertRefused(decideAuthor(fork({ sender: "writer", comments, permissionOf })));
});

// Sender checks ---------------------------------------------------------------

test("a bot sender needs a maintainer even with write and a same-repository writer PR", () => {
  for (const sender of ["helper[bot]", "HELPER[BOT]"]) {
    const permissionOf = () => "admin";
    assertRefused(decideAuthor(fork({ sender, prAuthor: "writer", headRepo: REPO, permissionOf })));
  }
});

test("a sender that is missing or not a string needs a maintainer", () => {
  for (const sender of [undefined, null, "", 7, { login: "writer" }]) {
    assertRefused(decideAuthor(fork({ sender, prAuthor: "writer", headRepo: REPO })));
  }
});

test("a sender with read or triage needs a maintainer on a same-repository writer PR", () => {
  for (const sender of ["contributor", "triager", "stranger"]) {
    assertRefused(decideAuthor(fork({ sender, prAuthor: "writer", headRepo: REPO })));
  }
});

test("a sender whose permission read throws needs a maintainer", () => {
  const permissionOf = () => {
    throw new Error("network");
  };
  assertRefused(decideAuthor(fork({ sender: "writer", prAuthor: "writer", headRepo: REPO, permissionOf })));
});

// Head repository and PR author ------------------------------------------------

test("headRepo null (a deleted fork) needs an approval", () => {
  assertRefused(decideAuthor(fork({ sender: "writer", prAuthor: "writer", headRepo: null })));
  const comments = [comment(`/ship-kit-review ${HEAD}`)];
  assert.deepEqual(decideAuthor(fork({ sender: "writer", prAuthor: "writer", headRepo: null, comments })), { run: true, basis: "approved" });
});

test("headRepo differing only in case is the same repository", () => {
  const result = decideAuthor(fork({ sender: "writer", prAuthor: "writer", headRepo: "ACME/Widgets" }));
  assert.deepEqual(result, { run: true, basis: "writer-pr" });
});

test("a fork PR by a writer still needs an approval", () => {
  assertRefused(decideAuthor(fork({ sender: "writer", prAuthor: "writer", headRepo: "writer/widgets" })));
});

test("a same-repository PR by an author without write needs a maintainer", () => {
  assertRefused(decideAuthor(fork({ sender: "writer", prAuthor: "contributor", headRepo: REPO })));
  assertRefused(decideAuthor(fork({ sender: "writer", prAuthor: undefined, headRepo: REPO })));
});

// Input validation ----------------------------------------------------------

test("malformed structural inputs throw", () => {
  assert.throws(() => decideAuthor(fork({ repo: "not-a-slug" })), TypeError);
  assert.throws(() => decideAuthor(fork({ headSha: HEAD.slice(0, 7) })), TypeError);
  assert.throws(() => decideAuthor(fork({ headSha: undefined })), TypeError);
  assert.throws(() => decideAuthor(fork({ minApprover: "triage" })), /minApprover/);
  assert.throws(() => decideAuthor(fork({ minApprover: "none" })), /minApprover/);
  assert.throws(() => decideAuthor(fork({ minApprover: "owner" })), /minApprover/);
  assert.throws(() => decideAuthor(fork({ comments: undefined })), /comments/);
  assert.throws(() => decideAuthor(fork({ permissionOf: undefined })), /permissionOf/);
  assert.throws(() => decideAuthor(fork({ headRepo: undefined })), /headRepo/);
});

// Permission ranks ----------------------------------------------------------

test("PERMISSION_RANK orders admin > maintain > write > triage > read > none", () => {
  assert.deepEqual(PERMISSION_RANK, { none: 0, read: 1, triage: 2, write: 3, maintain: 4, admin: 5 });
  assert.ok(Object.isFrozen(PERMISSION_RANK));
});

test("atLeast compares ranks and never passes an unknown permission", () => {
  assert.equal(atLeast("admin", "write"), true);
  assert.equal(atLeast("write", "write"), true);
  assert.equal(atLeast("triage", "write"), false);
  assert.equal(atLeast("maintain", "admin"), false);
  for (const value of ["custom-role", "toString", "__proto__", "", null, undefined, 3]) {
    assert.equal(atLeast(value, "none"), false, String(value));
  }
  assert.throws(() => atLeast("admin", "hasOwnProperty"), TypeError);
});

test("isBot recognizes bot logins, Bot-typed users and unusable users", () => {
  assert.equal(isBot("dependabot[bot]"), true);
  assert.equal(isBot({ login: "renovate[bot]", type: "User" }), true);
  assert.equal(isBot({ login: "some-app", type: "Bot" }), true);
  assert.equal(isBot({ login: "person", type: "User" }), false);
  assert.equal(isBot("person"), false);
  assert.equal(isBot("bot-person"), false);
  for (const value of [null, undefined, "", {}, { login: 5 }, 12]) assert.equal(isBot(value), true, JSON.stringify(value));
});

// needsMaintainerText -------------------------------------------------------

test("needsMaintainerText gives the reopen and draft instructions and the full head SHA", () => {
  const text = needsMaintainerText(HEAD.toUpperCase());
  assert.ok(text.startsWith("This PR comes from a fork or from an author without write access, or its last event was sent by one. "));
  assert.ok(text.includes("A maintainer who has read the diff comments `/ship-kit-review <full head sha>` and then closes and reopens the PR; the reopen runs the review with the maintainer as sender."));
  assert.ok(text.includes("A PR that cannot be reopened can be converted to draft and marked ready for review instead; that event also runs the review."));
  assert.equal(text.split("\n").at(-1), `Full head SHA: ${HEAD}`);
  assert.match(text, /^[\x20-\x7e\n]*$/);
  assert.throws(() => needsMaintainerText("abc"), TypeError);
});

// makePermissionOf through the gh client ------------------------------------

test("makePermissionOf reads role_name first, then permission", () => {
  const { gh } = ghWith([
    permissionRoute("lead", 200, { permission: "write", role_name: "maintain" }),
    permissionRoute("dev", 200, { permission: "write" }),
    permissionRoute("nullrole", 200, { permission: "admin", role_name: null }),
  ]);
  const permissionOf = makePermissionOf({ gh, repo: REPO });
  assert.equal(permissionOf("lead"), "maintain");
  assert.equal(permissionOf("dev"), "write");
  assert.equal(permissionOf("nullrole"), "admin");
});

test("role_name maintain with permission write ranks as maintain against minApprover maintain", () => {
  const { gh } = ghWith([
    permissionRoute("writer", 200, { permission: "write" }),
    permissionRoute("lead", 200, { permission: "write", role_name: "maintain" }),
  ]);
  const permissionOf = makePermissionOf({ gh, repo: REPO });
  const comments = [comment(`/ship-kit-review ${HEAD}`, "lead")];
  assert.deepEqual(decideAuthor(fork({ sender: "writer", comments, minApprover: "maintain", permissionOf })), { run: true, basis: "approved" });
});

test("an unknown role or permission value ranks none", () => {
  const { gh } = ghWith([
    permissionRoute("custom", 200, { permission: "write", role_name: "release-manager" }),
    permissionRoute("odd", 200, { permission: "superuser" }),
    permissionRoute("empty", 200, {}),
    permissionRoute("array", 200, ["write"]),
    permissionRoute("nulljson", 200, "null"),
  ]);
  const permissionOf = makePermissionOf({ gh, repo: REPO });
  for (const login of ["custom", "odd", "empty", "array", "nulljson"]) assert.equal(permissionOf(login), "none", login);
});

test("a 404 and a 403 from the permission API each rank none", () => {
  const { gh } = ghWith([
    permissionRoute("gone", 404, { message: "Not Found" }),
    permissionRoute("hidden", 403, { message: "Resource not accessible by integration", permission: "admin" }),
  ]);
  const permissionOf = makePermissionOf({ gh, repo: REPO });
  assert.equal(permissionOf("gone"), "none");
  assert.equal(permissionOf("hidden"), "none");
});

test("a timeout from the permission API ranks none", () => {
  const { gh } = ghWith([permissionRoute("slow", 200, { permission: "admin" }, { sleepMs: 2000 })], { timeoutMs: 200 });
  assert.equal(makePermissionOf({ gh, repo: REPO })("slow"), "none");
});

test("a gh that cannot answer ranks none", () => {
  const permissionOf = makePermissionOf({ gh: { get: () => { throw new Error("no gh"); } }, repo: REPO });
  assert.equal(permissionOf("writer"), "none");
});

test("a login with / or special characters is encoded, and . or .. is never requested", () => {
  const { gh, fake } = ghWith([
    permissionRoute("a%2Fb", 200, { permission: "admin" }),
    permissionRoute("..%2Fadmin", 200, { permission: "admin" }),
    permissionRoute("x%3Fy%23z", 200, { permission: "write" }),
  ]);
  const permissionOf = makePermissionOf({ gh, repo: REPO });
  assert.equal(permissionOf("a/b"), "admin");
  assert.equal(permissionOf("../admin"), "admin");
  assert.equal(permissionOf("x?y#z"), "write");
  assert.equal(permissionOf(".."), "none");
  assert.equal(permissionOf("."), "none");
  assert.equal(permissionOf(""), "none");
  assert.equal(permissionOf(undefined), "none");
  const paths = fake.calls().map((c) => c.argv.at(-1));
  assert.deepEqual(paths, [
    "repos/acme/widgets/collaborators/a%2Fb/permission",
    "repos/acme/widgets/collaborators/..%2Fadmin/permission",
    "repos/acme/widgets/collaborators/x%3Fy%23z/permission",
  ]);
});

test("permissions are cached per login", () => {
  const { gh, fake } = ghWith([permissionRoute("writer", 200, { permission: "write" }), permissionRoute("gone", 404, {})]);
  const permissionOf = makePermissionOf({ gh, repo: REPO });
  assert.equal(permissionOf("writer"), "write");
  assert.equal(permissionOf("writer"), "write");
  assert.equal(permissionOf("gone"), "none");
  assert.equal(permissionOf("gone"), "none");
  assert.equal(fake.calls().length, 2);
});

test("makePermissionOf validates its options", () => {
  assert.throws(() => makePermissionOf({ gh: {}, repo: REPO }), /gh must provide get/);
  assert.throws(() => makePermissionOf({ gh: { get() {} }, repo: "../x" }), TypeError);
});

test("an approval on page 2 of 101 comments is found", () => {
  const filler = Array.from({ length: 100 }, (_, i) => comment(`comment ${i}`, "contributor"));
  const approval = comment(`/ship-kit-review ${HEAD}`, "lead");
  const { gh } = ghWith([
    {
      args: ["api", "--paginate", "--slurp", "repos/acme/widgets/issues/5/comments?per_page=100"],
      stdout: JSON.stringify([filler, [approval]]),
    },
    permissionRoute("writer", 200, { permission: "write" }),
    permissionRoute("lead", 200, { permission: "maintain" }),
  ]);
  const comments = gh.list("repos/acme/widgets/issues/5/comments");
  assert.equal(comments.length, 101);
  const permissionOf = makePermissionOf({ gh, repo: REPO });
  assert.deepEqual(decideAuthor(fork({ sender: "writer", comments, permissionOf })), { run: true, basis: "approved" });
});
