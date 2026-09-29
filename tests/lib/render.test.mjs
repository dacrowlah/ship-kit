import assert from "node:assert/strict";
import test from "node:test";
import { PLACEHOLDER, RenderError, render } from "../../scripts/lib/render.mjs";

test("PLACEHOLDER matches a lowercase key wrapped in << >>", () => {
  assert.deepEqual([..."name: <<n>> and <<other_2>>".matchAll(PLACEHOLDER)].map((m) => m[1]), [
    "n",
    "other_2",
  ]);
});

test("inline values replace in place", () => {
  assert.equal(render("name: <<n>>\n", { n: "value" }), "name: value\n");
});

test("a value containing <<other>> is not re-expanded", () => {
  const out = render("name: <<n>>\n", { n: "text <<other>> stuff" });
  assert.equal(out, "name: text <<other>> stuff\n");
});

test("an unreplaced placeholder is refused", () => {
  assert.throws(
    () => render("name: <<n>>\n", {}),
    (error) => error instanceof RenderError && error.message.includes("<<n>>"),
  );
});

test("an unused value is refused", () => {
  assert.throws(
    () => render("name: <<n>>\n", { n: "x", other: "y" }),
    (error) => error instanceof RenderError && error.message.includes("<<other>>"),
  );
});

test("a newline in an inline value is refused", () => {
  assert.throws(
    () => render("name: <<n>>\n", { n: "a\nb" }),
    (error) => error instanceof RenderError && error.message.includes("<<n>>"),
  );
});

test("a fragment under run: | is indented two past the run line", () => {
  const template = [
    "jobs:",
    "  gate:",
    "    steps:",
    "      - name: x",
    "        run: |",
    "<<gate_script>>",
    "",
  ].join("\n");
  const out = render(template, { gate_script: 'echo "a"\necho "b"' });
  assert.equal(
    out,
    ["jobs:", "  gate:", "    steps:", "      - name: x", "        run: |", '          echo "a"', '          echo "b"', ""].join(
      "\n",
    ),
  );
});

test('a fragment under "- run: |" indents past the dash', () => {
  const template = ["  - run: |", "<<gate_script>>", ""].join("\n");
  const out = render(template, { gate_script: "echo hi" });
  assert.equal(out, ["  - run: |", "      echo hi", ""].join("\n"));
});

test("empty fragment lines stay empty", () => {
  const template = ["        run: |", "<<gate_script>>", ""].join("\n");
  const out = render(template, { gate_script: "echo a\n\necho b" });
  assert.equal(out, ["        run: |", "          echo a", "", "          echo b", ""].join("\n"));
});

test("an empty whole-line value removes the line", () => {
  const template = ["jobs:", "<<boot_job>>", "  review:", ""].join("\n");
  const out = render(template, { boot_job: "" });
  assert.equal(out, ["jobs:", "  review:", ""].join("\n"));
});

test("a multi-line whole-line value keeps its own indentation", () => {
  const template = ["jobs:", "<<boot_job>>", "  review:", ""].join("\n");
  const out = render(template, { boot_job: "  boot:\n    uses: x" });
  assert.equal(out, ["jobs:", "  boot:", "    uses: x", "  review:", ""].join("\n"));
});

test("an indented whole-line placeholder is refused", () => {
  const template = ["jobs:", "  <<gate_script>>", ""].join("\n");
  assert.throws(
    () => render(template, { gate_script: "echo hi" }),
    (error) => error instanceof RenderError && error.message.includes("<<gate_script>>"),
  );
});

test("CRLF templates render as LF", () => {
  const template = "name: <<n>>\r\nother: 1\r\n";
  const out = render(template, { n: "x" });
  assert.equal(out, "name: x\nother: 1\n");
  assert.equal(out.includes("\r"), false);
});

test("a template with no trailing newline still renders with one", () => {
  assert.equal(render("name: <<n>>", { n: "x" }), "name: x\n");
});

test("a whole-line placeholder with no run: | above it and a non-empty value replaces the line", () => {
  const template = ["a:", "<<k>>", "b:", ""].join("\n");
  assert.equal(render(template, { k: "c: 1" }), ["a:", "c: 1", "b:", ""].join("\n"));
});

// --- Mutation guards (standard closing step 2) ---
// Each row below matches implementer-contract.md's mutation table for this
// task and is proven red by the standard closing's mutation procedure.

test("mutation guard: a value containing <<other>> is not re-expanded (guards against rescanning output)", () => {
  const out = render("name: <<n>>\n", { n: "<<other>>" });
  assert.equal(out, "name: <<other>>\n");
});

test("mutation guard: an unused value is refused (guards a skipped unused-value check)", () => {
  assert.throws(() => render("name: <<n>>\n", { n: "x", unused: "y" }), RenderError);
});

test("mutation guard: a fragment is indented from the run: line, not the placeholder's own column-0 line", () => {
  const template = ["        run: |", "<<gate_script>>", ""].join("\n");
  const out = render(template, { gate_script: "echo hi" });
  // The placeholder line itself is at column 0; if indentation were taken
  // from it instead of the run: line above, the fragment would sit at 2
  // spaces, not 10.
  assert.equal(out, ["        run: |", "          echo hi", ""].join("\n"));
  assert.notEqual(out, ["        run: |", "  echo hi", ""].join("\n"));
});
