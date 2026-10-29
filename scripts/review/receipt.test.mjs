import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isolatedEnv } from "../assert-test-globs.mjs";
import { MAX_EXECUTION_BYTES, main, readExecutionBody } from "./receipt.mjs";

const SCRIPT = fileURLToPath(new URL("./receipt.mjs", import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "receipt-"));

function seatOutput(overrides = {}) {
  return {
    verdict: "PASS",
    complete: true,
    unreviewed: [],
    summary: "Checked the change.",
    contract_nonce: "c".repeat(32),
    skill_marker: `reviewing-for-correctness@0.2.0:${"ab".repeat(8)}`,
    ...overrides,
  };
}

/** An execution file: the SDK message array claude-code-action writes. */
function execution(structured, extra = []) {
  return JSON.stringify([
    { type: "system", subtype: "init", tools: ["Read"] },
    { type: "assistant", message: { content: [{ type: "text", text: "reading" }] } },
    ...extra,
    { type: "result", subtype: "success", is_error: false, structured_output: structured },
  ]);
}

/** Writes `text` as the execution file and runs main; returns the exit code, the receipt and its raw text. */
function runReceipt(text, { index = "3", seat = "general", env = {} } = {}) {
  const dir = tmp();
  const file = join(dir, "execution.json");
  if (text !== null) writeFileSync(file, text);
  const out = join(dir, "out");
  const errors = [];
  const code = main([index], { EXECUTION_FILE: file, SEAT: seat, OUT_DIR: out, ...env }, { err: { write: (s) => errors.push(s) } });
  const path = join(out, "receipt.json");
  const raw = existsSync(path) ? readFileSync(path, "utf8") : null;
  return { code, raw, receipt: raw === null ? null : JSON.parse(raw), errors, dir, out };
}

test("readExecutionBody takes the last result message's structured_output", () => {
  const first = seatOutput({ summary: "first result" });
  const last = seatOutput({ summary: "last result", verdict: "FAIL" });
  const text = JSON.stringify([
    { type: "result", subtype: "success", structured_output: first },
    { type: "assistant", message: { content: [] } },
    { type: "result", subtype: "success", structured_output: last },
  ]);
  assert.deepEqual(readExecutionBody(text), last);
});

test("a last result without a plain-object structured_output is null, even after a good one", () => {
  for (const bad of [undefined, null, "text", 3, [seatOutput()]]) {
    const text = JSON.stringify([
      { type: "result", structured_output: seatOutput() },
      { type: "result", structured_output: bad },
    ]);
    assert.equal(readExecutionBody(text), null, JSON.stringify(bad));
  }
});

test("messages after the last result do not hide it", () => {
  const text = JSON.stringify([
    { type: "result", structured_output: seatOutput() },
    { type: "assistant", message: { content: [] } },
    null,
    "noise",
  ]);
  assert.deepEqual(readExecutionBody(text), seatOutput());
});

test("unparseable, non-array, result-less and non-string input is null", () => {
  assert.equal(readExecutionBody("{not json"), null);
  assert.equal(readExecutionBody(""), null);
  assert.equal(readExecutionBody(JSON.stringify({ type: "result", structured_output: seatOutput() })), null);
  assert.equal(readExecutionBody(JSON.stringify([{ type: "assistant" }])), null);
  assert.equal(readExecutionBody(JSON.stringify([])), null);
  assert.equal(readExecutionBody(undefined), null);
});

test("a receipt carries index, seat and the body", () => {
  const { code, receipt } = runReceipt(execution(seatOutput()));
  assert.equal(code, 0);
  assert.deepEqual(receipt, { index: 3, seat: "general", body: seatOutput() });
});

test("a receipt from an execution file over 128 KiB is read whole", () => {
  const summary = "x".repeat(1024 * 1024);
  const text = execution(seatOutput({ summary }));
  assert.ok(Buffer.byteLength(text) > 128 * 1024);
  const { code, receipt } = runReceipt(text);
  assert.equal(code, 0);
  assert.equal(receipt.body.summary.length, summary.length);
  assert.deepEqual(receipt.body, seatOutput({ summary }));
});

test("a missing or non-JSON execution file yields body null", () => {
  for (const text of [null, "", "not json at all", "[{\"type\":\"result\""]) {
    const { code, receipt } = runReceipt(text);
    assert.equal(code, 0, String(text));
    assert.deepEqual(receipt, { index: 3, seat: "general", body: null });
  }
  const unset = runReceipt(execution(seatOutput()), { env: { EXECUTION_FILE: "" } });
  assert.deepEqual(unset.receipt, { index: 3, seat: "general", body: null });
  const absent = runReceipt(execution(seatOutput()), { env: { EXECUTION_FILE: undefined } });
  assert.deepEqual(absent.receipt, { index: 3, seat: "general", body: null });
});

test("an execution file over the size limit, or a directory, yields body null", () => {
  const dir = tmp();
  // Valid JSON padded with whitespace past the limit: only the size check refuses it.
  const big = join(dir, "big.json");
  const padded = Buffer.alloc(MAX_EXECUTION_BYTES + 1, 0x20);
  padded.write(execution(seatOutput()));
  writeFileSync(big, padded);
  assert.notEqual(readExecutionBody(padded.toString("utf8")), null);
  const out = join(dir, "out");
  assert.equal(main(["1"], { EXECUTION_FILE: big, SEAT: "general", OUT_DIR: out }), 0);
  assert.deepEqual(JSON.parse(readFileSync(join(out, "receipt.json"), "utf8")), { index: 1, seat: "general", body: null });

  const asDir = join(dir, "a-directory");
  mkdirSync(asDir);
  assert.equal(main(["1"], { EXECUTION_FILE: asDir, SEAT: "general", OUT_DIR: out }), 0);
  assert.deepEqual(JSON.parse(readFileSync(join(out, "receipt.json"), "utf8")), { index: 1, seat: "general", body: null });
});

test("a credential-shaped body is never written to the receipt", () => {
  const cases = {
    summary: seatOutput({ summary: "the log showed ghp_EXAMPLEEXAMPLE here" }),
    unreviewed: seatOutput({ unreviewed: ["../pr/x: holds sk-ant-EXAMPLE"] }),
    key: { ...seatOutput(), "github_pat_EXAMPLE": "value" },
    hidden: seatOutput({ summary: "x-access-\u200Btoken:EXAMPLE" }),
  };
  for (const [name, body] of Object.entries(cases)) {
    const { code, raw, receipt } = runReceipt(execution(body));
    assert.equal(code, 0, name);
    assert.deepEqual(receipt, { index: 3, seat: "general", body: null, withheld: true }, name);
    for (const needle of ["ghp_", "sk-ant-", "github_pat_", "EXAMPLE", "Checked the change"]) {
      assert.ok(!raw.includes(needle), `${name}: ${needle}`);
    }
  }
});

test("usage errors write nothing and exit 2", () => {
  const dir = tmp();
  const file = join(dir, "execution.json");
  writeFileSync(file, execution(seatOutput()));
  const out = join(dir, "out");
  const good = { EXECUTION_FILE: file, SEAT: "general", OUT_DIR: out };
  const cases = [
    [[], good],
    [["1", "2"], good],
    [["0"], good],
    [["-1"], good],
    [["1.5"], good],
    [["01"], good],
    [["abc"], good],
    [["1"], { ...good, SEAT: "reviewer" }],
    [["1"], { ...good, SEAT: undefined }],
    [["1"], { ...good, OUT_DIR: "relative/out" }],
    [["1"], { ...good, OUT_DIR: undefined }],
  ];
  for (const [argv, env] of cases) {
    const errors = [];
    assert.equal(main(argv, env, { err: { write: (s) => errors.push(s) } }), 2, JSON.stringify([argv, env.SEAT, env.OUT_DIR]));
    assert.ok(errors.join("").startsWith("receipt:"));
    assert.equal(existsSync(join(out, "receipt.json")), false);
  }
});

test("a receipt that cannot be written exits 1", () => {
  const dir = tmp();
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "a file where the output directory should be");
  const errors = [];
  const code = main(["1"], { EXECUTION_FILE: join(dir, "none.json"), SEAT: "general", OUT_DIR: join(blocker, "out") }, { err: { write: (s) => errors.push(s) } });
  assert.equal(code, 1);
  assert.match(errors.join(""), /^receipt: could not write/);
});

test("the script run as a command writes its receipt", () => {
  const dir = tmp();
  const file = join(dir, "execution.json");
  writeFileSync(file, execution(seatOutput({ verdict: "FAIL" })));
  const out = join(dir, "out");
  const result = spawnSync(process.execPath, [SCRIPT, "2"], {
    env: { ...isolatedEnv(), EXECUTION_FILE: file, SEAT: "adversarial", OUT_DIR: out },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(out, "receipt.json"), "utf8")), {
    index: 2, seat: "adversarial", body: seatOutput({ verdict: "FAIL" }),
  });
  const bad = spawnSync(process.execPath, [SCRIPT], { env: isolatedEnv(), encoding: "utf8" });
  assert.equal(bad.status, 2);
});
