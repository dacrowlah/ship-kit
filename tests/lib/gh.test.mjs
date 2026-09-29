import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { delimiter } from "node:path";
import test from "node:test";
import { isolatedEnv } from "../../scripts/assert-test-globs.mjs";
import { CallError, api, makeGh, repoSlug, seg } from "../../scripts/lib/gh.mjs";
import { included, makeFakeGhApi } from "../helpers/fake-gh-api.mjs";

const MODULE_URL = new URL("../../scripts/lib/gh.mjs", import.meta.url).href;

/** A gh client whose `run` executes the scripted fake instead of `gh` on PATH. */
function ghWith(routes, options = {}) {
  const fake = makeFakeGhApi(routes);
  const run = (file, args, opts) => {
    assert.equal(file, "gh");
    return execFileSync(fake.bin, args, { ...opts, env: isolatedEnv() });
  };
  return { gh: makeGh({ run, ...options }), fake };
}

const items = (n, start = 0) => Array.from({ length: n }, (_, i) => ({ id: start + i }));

// get ------------------------------------------------------------------

test("get reads a 200 body", () => {
  const { gh } = ghWith([{ args: ["api", "--include", "repos/o/r"], stdout: included(200, { id: 7 }, "OK") }]);
  assert.deepEqual(gh.get("repos/o/r"), { status: 200, json: { id: 7 } });
});

test("get returns 404 without throwing", () => {
  const { gh } = ghWith([{
    args: ["api", "--include", "repos/o/r/branches/main/protection"],
    stdout: included(404, { message: "Branch not protected" }, "Not Found"),
    stderr: "gh: Branch not protected (HTTP 404)\n",
    code: 1,
  }]);
  const result = gh.get("repos/o/r/branches/main/protection");
  assert.equal(result.status, 404);
  assert.deepEqual(result.json, { message: "Branch not protected" });
});

test("get returns 403 from a rate limit", () => {
  const { gh } = ghWith([{
    args: ["api", "--include", "rate_limited"],
    stdout: included(403, { message: "API rate limit exceeded" }, "Forbidden"),
    code: 1,
  }]);
  assert.equal(gh.get("rate_limited").status, 403);
});

test("get with no status line throws", () => {
  const { gh } = ghWith([{ args: ["api", "--include", "x"], stderr: "error connecting to api.github.com\n", code: 1 }]);
  assert.throws(() => gh.get("x"), (e) => e instanceof CallError && /no HTTP status line/.test(e.message) && /gh api --include x/.test(e.message));
});

test("get with text before the status line throws", () => {
  const { gh } = ghWith([{ args: ["api", "--include", "x"], stdout: "warning\n" + included(200, {}) }]);
  assert.throws(() => gh.get("x"), CallError);
});

test("get with no blank line after the headers throws", () => {
  const { gh } = ghWith([{ args: ["api", "--include", "x"], stdout: "HTTP/2.0 200 OK\nA: b\r\n" }]);
  assert.throws(() => gh.get("x"), /no blank line/);
});

test("get with a non-JSON 200 body throws", () => {
  const { gh } = ghWith([{ args: ["api", "--include", "x"], stdout: included(200, "<html>not json</html>") }]);
  assert.throws(() => gh.get("x"), (e) => e instanceof CallError && /not JSON/.test(e.message));
});

test("get returns a non-JSON error body as null", () => {
  const { gh } = ghWith([{ args: ["api", "--include", "x"], stdout: included(502, "<html>bad gateway</html>"), code: 1 }]);
  assert.deepEqual(gh.get("x"), { status: 502, json: null });
});

test("get reads an empty 204 body as null", () => {
  const { gh } = ghWith([{ args: ["api", "--include", "x"], stdout: included(204, "", "No Content") }]);
  assert.deepEqual(gh.get("x"), { status: 204, json: null });
});

test("get refuses an empty 200 body", () => {
  const { gh } = ghWith([{ args: ["api", "--include", "x"], stdout: included(200, "", "OK") }]);
  assert.throws(() => gh.get("x"), (e) => e instanceof CallError && /HTTP 200 body is not JSON/.test(e.message));
});

test("send refuses a whitespace-only 201 body", () => {
  const { gh } = ghWith([{ args: ["api", "--include", "--method", "POST", "--input", "-", "x"], stdout: included(201, "  \n", "Created") }]);
  assert.throws(() => gh.send("POST", "x", {}), (e) => e instanceof CallError && /HTTP 201 body is not JSON/.test(e.message));
});

test("get refuses a non-empty 204 body that is not JSON", () => {
  const { gh } = ghWith([{ args: ["api", "--include", "x"], stdout: included(204, "junk", "No Content") }]);
  assert.throws(() => gh.get("x"), CallError);
});

test("get reads an empty error body as null", () => {
  const { gh } = ghWith([{ args: ["api", "--include", "x"], stdout: included(404, "", "Not Found"), code: 1 }]);
  assert.deepEqual(gh.get("x"), { status: 404, json: null });
});

test("get refuses a 2xx status with a non-zero exit", () => {
  const { gh } = ghWith([{ args: ["api", "--include", "x"], stdout: included(200, {}), code: 1 }]);
  assert.throws(() => gh.get("x"), /exited 1/);
});

test("get reads a status line with LF-only headers", () => {
  const { gh } = ghWith([{ args: ["api", "--include", "x"], stdout: "HTTP/1.1 200 OK\nA: b\n\n[1]" }]);
  assert.deepEqual(gh.get("x"), { status: 200, json: [1] });
});

for (const bad of [
  "", "-X", "--method=DELETE", "a b", "a\nb", "a\tb", "a\u007fb", "caf\u00e9", 5, null, undefined, ["x"],
  "https://evil.example/x", "repos/o/r/contents/a?ref=https://evil.example/", "repos/o/r#frag",
]) {
  test(`get refuses the path ${JSON.stringify(bad)} before running gh`, () => {
    let ran = false;
    const gh = makeGh({ run: () => { ran = true; return ""; } });
    assert.throws(() => gh.get(bad), TypeError);
    assert.equal(ran, false);
  });
}

// list and listKey -----------------------------------------------------

test("list flattens 101 items over two pages", () => {
  const { gh, fake } = ghWith([{
    args: ["api", "--paginate", "--slurp", "repos/o/r/pulls?per_page=100"],
    stdout: JSON.stringify([items(100), items(1, 100)]),
  }]);
  const result = gh.list("repos/o/r/pulls");
  assert.equal(result.length, 101);
  assert.deepEqual(result[100], { id: 100 });
  assert.equal(fake.calls().length, 1);
});

test("list joins per_page to a path that already has a query with &", () => {
  const { gh } = ghWith([{
    args: ["api", "--paginate", "--slurp", "repos/o/r/pulls?state=all&per_page=100"],
    stdout: JSON.stringify([[]]),
  }]);
  assert.deepEqual(gh.list("repos/o/r/pulls?state=all"), []);
});

test("list refuses a path that already sets per_page", () => {
  const gh = makeGh({ run: () => assert.fail("must not run") });
  assert.throws(() => gh.list("repos/o/r/pulls?per_page=5"), TypeError);
  assert.throws(() => gh.listKey("repos/o/r/actions/artifacts?PER_PAGE=5", "artifacts"), TypeError);
});

test("list refuses a page that is not an array", () => {
  const { gh } = ghWith([{
    args: ["api", "--paginate", "--slurp", "p?per_page=100"],
    stdout: JSON.stringify([items(100), { message: "odd" }]),
  }]);
  assert.throws(() => gh.list("p"), (e) => e instanceof CallError && /page 2 is not an array/.test(e.message));
});

for (const [name, stdout] of [
  ["a top level that is not an array", JSON.stringify({ a: 1 })],
  ["no pages at all", "[]"],
  ["output that is not JSON", "[[1,2],"],
]) {
  test(`list refuses ${name}`, () => {
    const { gh } = ghWith([{ args: ["api", "--paginate", "--slurp", "p?per_page=100"], stdout }]);
    assert.throws(() => gh.list("p"), CallError);
  });
}

test("list refuses a non-zero exit", () => {
  const { gh } = ghWith([{
    args: ["api", "--paginate", "--slurp", "p?per_page=100"],
    stdout: JSON.stringify([items(100)]),
    stderr: "gh: API rate limit exceeded (HTTP 403)\n",
    code: 1,
  }]);
  let result;
  assert.throws(() => { result = gh.list("p"); }, (e) => e instanceof CallError && /exited 1/.test(e.message) && /rate limit/.test(e.message));
  assert.equal(result, undefined);
});

test("listKey refuses when collected items differ from total_count", () => {
  const { gh } = ghWith([{
    args: ["api", "--paginate", "--slurp", "repos/o/r/actions/artifacts?per_page=100"],
    stdout: JSON.stringify([{ total_count: 150, artifacts: items(100) }]),
  }]);
  assert.throws(
    () => gh.listKey("repos/o/r/actions/artifacts", "artifacts"),
    (e) => e instanceof CallError && /truncated/.test(e.message) && /100 of 150/.test(e.message),
  );
});

test("listKey refuses more items than total_count", () => {
  const { gh } = ghWith([{
    args: ["api", "--paginate", "--slurp", "p?per_page=100"],
    stdout: JSON.stringify([{ total_count: 1, runs: items(2) }]),
  }]);
  assert.throws(() => gh.listKey("p", "runs"), /truncated/);
});

test("listKey accepts a matching total", () => {
  const { gh } = ghWith([{
    args: ["api", "--paginate", "--slurp", "repos/o/r/commits/abc/check-runs?filter=latest&per_page=100"],
    stdout: JSON.stringify([
      { total_count: 101, check_runs: items(100) },
      { total_count: 101, check_runs: items(1, 100) },
    ]),
  }]);
  const runs = gh.listKey("repos/o/r/commits/abc/check-runs?filter=latest", "check_runs");
  assert.equal(runs.length, 101);
  assert.deepEqual(runs[100], { id: 100 });
});

test("listKey accepts an empty listing with total_count 0", () => {
  const { gh } = ghWith([{ args: ["api", "--paginate", "--slurp", "p?per_page=100"], stdout: JSON.stringify([{ total_count: 0, runs: [] }]) }]);
  assert.deepEqual(gh.listKey("p", "runs"), []);
});

for (const [name, pages] of [
  ["a page that is an array", [[1]]],
  ["a page that is null", [null]],
  ["a page without the key", [{ total_count: 1, other: [1] }]],
  ["a page whose key is not an array", [{ total_count: 1, runs: { a: 1 } }]],
  ["no pages at all", []],
]) {
  test(`listKey refuses ${name}`, () => {
    const { gh } = ghWith([{ args: ["api", "--paginate", "--slurp", "p?per_page=100"], stdout: JSON.stringify(pages) }]);
    assert.throws(() => gh.listKey("p", "runs"), CallError);
  });
}

for (const [name, pages] of [
  ["a missing total_count", [{ runs: [1] }]],
  ["a negative total_count", [{ total_count: -1, runs: [] }]],
  ["a fractional total_count", [{ total_count: 1.5, runs: [1] }]],
  ["a string total_count", [{ total_count: "1", runs: [1] }]],
  ["a later page with a different total_count", [{ total_count: 2, runs: [1] }, { total_count: 5, runs: [2] }]],
  ["a later page without a total_count", [{ total_count: 2, runs: [1] }, { runs: [2] }]],
]) {
  test(`listKey refuses ${name}`, () => {
    const { gh } = ghWith([{ args: ["api", "--paginate", "--slurp", "p?per_page=100"], stdout: JSON.stringify(pages) }]);
    assert.throws(() => gh.listKey("p", "runs"), (e) => e instanceof CallError && /total_count/.test(e.message) && !/truncated/.test(e.message));
  });
}

test("listKey refuses a later page of the wrong shape as CallError", () => {
  const { gh } = ghWith([{
    args: ["api", "--paginate", "--slurp", "p?per_page=100"],
    stdout: JSON.stringify([{ total_count: 101, runs: items(100) }, { total_count: 101, other: [1] }]),
  }]);
  assert.throws(() => gh.listKey("p", "runs"), (e) => e instanceof CallError && /page 2 /.test(e.message));
});

test("listKey refuses a non-zero exit", () => {
  const { gh } = ghWith([{
    args: ["api", "--paginate", "--slurp", "p?per_page=100"],
    stdout: JSON.stringify([{ total_count: 1, runs: [1] }]),
    code: 1,
  }]);
  assert.throws(() => gh.listKey("p", "runs"), CallError);
});

test("listKey refuses a key that is not a non-empty string", () => {
  const gh = makeGh({ run: () => assert.fail("must not run") });
  assert.throws(() => gh.listKey("p", ""), TypeError);
  assert.throws(() => gh.listKey("p", 1), TypeError);
});

// send -----------------------------------------------------------------

test("send never puts the body in argv", () => {
  const body = { body: "a comment text 5e1f", event: "COMMENT" };
  const { gh, fake } = ghWith([{
    args: ["api", "--include", "--method", "POST", "--input", "-", "repos/o/r/issues/5/comments"],
    stdout: included(201, { id: 9 }, "Created"),
  }]);
  assert.deepEqual(gh.send("POST", "repos/o/r/issues/5/comments", body), { status: 201, json: { id: 9 } });
  const [call] = fake.calls();
  assert.ok(!call.argv.some((arg) => arg.includes("5e1f")), "the body text must not be in argv");
  assert.equal(call.stdin, JSON.stringify(body));
});

test("send without a body sends no input", () => {
  const { gh, fake } = ghWith([{
    args: ["api", "--include", "--method", "DELETE", "repos/o/r/labels/x"],
    stdout: included(204, "", "No Content"),
  }]);
  assert.deepEqual(gh.send("DELETE", "repos/o/r/labels/x"), { status: 204, json: null });
  assert.equal(fake.calls()[0].stdin, "");
});

test("send returns a 422 without throwing", () => {
  const { gh } = ghWith([{
    args: ["api", "--include", "--method", "PUT", "--input", "-", "p"],
    stdout: included(422, { message: "Validation Failed" }),
    code: 1,
  }]);
  assert.equal(gh.send("PUT", "p", {}).status, 422);
});

for (const [name, body] of [["a function", () => 1], ["a symbol", Symbol("s")]]) {
  test(`send refuses a body that does not serialise (${name})`, () => {
    const gh = makeGh({ run: () => assert.fail("must not run") });
    assert.throws(() => gh.send("POST", "p", body), TypeError);
  });
}

for (const method of ["get", "POST ", "-X", "OPTIONS", "", 1]) {
  test(`send refuses the method ${JSON.stringify(method)}`, () => {
    const gh = makeGh({ run: () => assert.fail("must not run") });
    assert.throws(() => gh.send(method, "p", {}), TypeError);
  });
}

// cli ------------------------------------------------------------------

test("cli returns stdout", () => {
  const { gh } = ghWith([{ args: ["pr", "view", "5", "--json", "state"], stdout: "{\"state\":\"OPEN\"}\n" }]);
  assert.equal(gh.cli(["pr", "view", "5", "--json", "state"]), "{\"state\":\"OPEN\"}\n");
});

test("cli refuses a non-zero exit, naming the command", () => {
  const { gh } = ghWith([{ args: ["pr", "view", "5"], stdout: "partial", stderr: "no pull requests found\n", code: 1 }]);
  assert.throws(() => gh.cli(["pr", "view", "5"]), (e) => e instanceof CallError && /gh pr view 5/.test(e.message) && /no pull requests found/.test(e.message));
});

for (const bad of [[], "pr view", ["pr", 5], null]) {
  test(`cli refuses the arguments ${JSON.stringify(bad)}`, () => {
    const gh = makeGh({ run: () => assert.fail("must not run") });
    assert.throws(() => gh.cli(bad), TypeError);
  });
}

// process bounds -------------------------------------------------------

test("a slow gh times out", () => {
  const { gh } = ghWith([{ args: ["api", "--include", "slow"], stdout: included(200, {}), sleepMs: 2000 }], { timeoutMs: 100 });
  const started = Date.now();
  assert.throws(() => gh.get("slow"), (e) => e instanceof CallError && /timed out after 100 ms/.test(e.message));
  assert.ok(Date.now() - started < 1900, "the call must end at the timeout, not when gh answers");
});

test("every call runs gh with the timeout, a 256 MiB buffer and piped stdio", () => {
  const seen = [];
  const gh = makeGh({
    timeoutMs: 1234,
    run: (file, args, opts) => {
      seen.push({ file, opts });
      if (args[1] === "--include") return included(200, {});
      if (args[3] === "c?per_page=100") return JSON.stringify([{ total_count: 0, k: [] }]);
      return "[[]]";
    },
  });
  gh.get("a");
  gh.list("b");
  gh.listKey("c", "k");
  gh.send("POST", "d", { x: 1 });
  gh.cli(["version"]);
  assert.equal(seen.length, 5);
  for (const { file, opts } of seen) {
    assert.equal(file, "gh");
    assert.equal(opts.timeout, 1234);
    assert.equal(opts.maxBuffer, 256 * 1024 * 1024);
    assert.deepEqual(opts.stdio, ["pipe", "pipe", "pipe"]);
    assert.equal(opts.encoding, "utf8");
  }
  assert.equal(seen[3].opts.input, JSON.stringify({ x: 1 }));
});

test("the default timeout is 60 seconds", () => {
  let timeout;
  makeGh({ run: (f, a, opts) => { timeout = opts.timeout; return "x"; } }).cli(["version"]);
  assert.equal(timeout, 60000);
});

for (const [name, error] of [
  ["a buffer overflow", Object.assign(new Error("spawnSync gh ENOBUFS"), { code: "ENOBUFS", status: 0, stdout: "" })],
  ["a missing gh", Object.assign(new Error("spawnSync gh ENOENT"), { code: "ENOENT" })],
  ["a kill by signal", Object.assign(new Error("killed"), { status: null, signal: "SIGKILL", stdout: "" })],
  ["a timeout reported by code", Object.assign(new Error("spawnSync gh ETIMEDOUT"), { code: "ETIMEDOUT", status: null, stdout: "" })],
  ["a thrown non-Error", "boom"],
]) {
  test(`${name} throws CallError naming the command`, () => {
    const gh = makeGh({ run: () => { throw error; } });
    assert.throws(() => gh.get("repos/o/r"), (e) => e instanceof CallError && /gh api --include repos\/o\/r/.test(e.message));
    assert.throws(() => gh.cli(["pr", "list"]), CallError);
  });
}

test("a kill by signal after a complete response still throws", () => {
  const error = Object.assign(new Error("killed"), { status: null, signal: "SIGKILL", stdout: included(404, { message: "Not Found" }) });
  const gh = makeGh({ run: () => { throw error; } });
  assert.throws(() => gh.get("x"), (e) => e instanceof CallError && /killed by SIGKILL/.test(e.message));
});

test("a buffer overflow is named as such", () => {
  const gh = makeGh({ run: () => { throw Object.assign(new Error("x"), { code: "ENOBUFS" }); } });
  assert.throws(() => gh.list("p"), /output exceeded 268435456 bytes/);
});

for (const bad of [0, -1, 1.5, "100", Infinity]) {
  test(`makeGh refuses the timeout ${String(bad)}`, () => {
    assert.throws(() => makeGh({ run: () => "", timeoutMs: bad }), TypeError);
  });
}

test("makeGh refuses a run that is not a function and defaults it", () => {
  assert.throws(() => makeGh({ run: "gh" }), TypeError);
  const gh = makeGh();
  assert.equal(typeof gh.get, "function");
  assert.equal(typeof makeGh({}).cli, "function");
});

test("CallError is an Error named CallError", () => {
  const error = new CallError("m");
  assert.ok(error instanceof Error);
  assert.equal(error.name, "CallError");
});

test("the default run reaches gh on PATH in a real child", () => {
  const fake = makeFakeGhApi([{ args: ["api", "--include", "repos/o/r"], stdout: included(404, { message: "Not Found" }), code: 1 }]);
  const script = `import(${JSON.stringify(MODULE_URL)}).then((m) => process.stdout.write(JSON.stringify(m.makeGh().get("repos/o/r"))));`;
  const env = isolatedEnv();
  env.PATH = `${fake.dir}${delimiter}${process.env.PATH}`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { status: 404, json: { message: "Not Found" } });
  assert.deepEqual(fake.calls(), [{ argv: ["api", "--include", "repos/o/r"], stdin: "" }]);
});

// seg, api, repoSlug -----------------------------------------------------

test("seg encodes release/1.x as release%2F1.x", () => {
  assert.equal(seg("release/1.x"), "release%2F1.x");
  assert.equal(seg("a#b"), "a%23b");
  assert.equal(seg("a?b"), "a%3Fb");
  assert.equal(seg("50%"), "50%25");
  assert.equal(seg("a b"), "a%20b");
  assert.equal(seg("{owner}"), "%7Bowner%7D");
  assert.equal(seg("caf\u00e9"), "caf%C3%A9");
  assert.equal(seg("..."), "...");
  assert.equal(seg(12), "12");
});

test("seg encodes a marker runId that tries to leave its segment", () => {
  assert.equal(seg("1/../x"), "1%2F..%2Fx");
  assert.equal(seg("12?a=b"), "12%3Fa%3Db");
  assert.equal(seg("12&per_page=1"), "12%26per_page%3D1");
});

for (const bad of ["", ".", "..", 0, -1, 1.5, NaN, Infinity, 2 ** 53, 1n, null, undefined, true, {}, [], ["a"], "\ud800"]) {
  test(`seg refuses ${typeof bad === "bigint" ? "1n" : JSON.stringify(bad) ?? String(bad)}`, () => {
    assert.throws(() => seg(bad), TypeError);
  });
}

test("api encodes every value", () => {
  const o = "octo-org";
  const r = "my.repo";
  const b = "release/1.x";
  assert.equal(api`repos/${o}/${r}/branches/${b}/protection`, "repos/octo-org/my.repo/branches/release%2F1.x/protection");
  assert.equal(api`repos/${o}/${r}/issues/${5}/comments?per_page=10`, "repos/octo-org/my.repo/issues/5/comments?per_page=10");
  assert.equal(api`rate_limit`, "rate_limit");
});

test("api refuses a value seg refuses", () => {
  assert.throws(() => api`repos/o/r/branches/${".."}`, TypeError);
  assert.throws(() => api`repos/o/r/actions/runs/${0}`, TypeError);
});

test("repoSlug splits a valid slug", () => {
  assert.deepEqual(repoSlug("octo-org/my.repo_1"), { owner: "octo-org", name: "my.repo_1", slug: "octo-org/my.repo_1" });
  assert.deepEqual(repoSlug(`${"a".repeat(39)}/${"b".repeat(100)}`).name.length, 100);
  assert.equal(repoSlug("a/...").name, "...");
});

for (const bad of [
  "a/b/c", "../x", "-a/b", "a/..", "", "a/.", "a", "/b", "a/", "a b/c", "a/b\n", "a/b c", "a_b/c",
  `${"a".repeat(40)}/b`, `a/${"b".repeat(101)}`, "a/b%2F", null, 5, {},
]) {
  test(`repoSlug refuses ${JSON.stringify(bad)}`, () => {
    assert.throws(() => repoSlug(bad), TypeError);
  });
}
