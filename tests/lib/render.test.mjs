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

test("a value containing another placeholder's own text is not re-expanded, even when that placeholder is supplied and used elsewhere", () => {
  // A weaker guard here (only "other" as an unsupplied key) cannot tell a
  // genuinely single-pass renderer apart from one that rescans but skips
  // keys with no value: here "b" IS supplied and IS used in the template,
  // so a rescan would substitute it into a's already-rendered text.
  const out = render("a: <<a>>\nb: <<b>>\n", { a: "<<b>>", b: "REAL" });
  assert.equal(out, "a: <<b>>\nb: REAL\n");
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

// --- Expression openers: the chokepoint for config-derived values ---
// Design 6.5 picked `<<key>>` so placeholders never collide with `${{ }}`;
// no legitimate value needs an expression, and a value that carried one
// into a workflow would hand its author a live GitHub Actions expression.

const OPENER = "$" + "{{";

test("an inline value containing an expression opener is refused, naming the key", () => {
  assert.throws(
    () => render("name: <<n>>\n", { n: `${OPENER} github.event.pull_request.title }}` }),
    (error) => error instanceof RenderError && error.message.includes("<<n>>") && error.message.includes(OPENER),
  );
});

test("an expression opener anywhere inside a longer inline value is refused", () => {
  assert.throws(() => render("name: <<n>>\n", { n: `echo hi ${OPENER} x }} tail` }), RenderError);
});

test("a whole-line value containing an expression opener is refused", () => {
  assert.throws(() => render("jobs:\n<<boot_job>>\n", { boot_job: `  boot:\n    if: ${OPENER} x }}` }), RenderError);
});

test("a fragment value containing an expression opener is refused, on any of its lines", () => {
  const template = ["        run: |", "<<gate_script>>", ""].join("\n");
  assert.throws(() => render(template, { gate_script: `echo one\necho ${OPENER} x }}` }), RenderError);
});

test("an expression opener in a value that is not used by the template still reports the unused key", () => {
  assert.throws(
    () => render("name: <<n>>\n", { n: "x", other: OPENER }),
    (error) => error instanceof RenderError && error.message.includes("<<other>>"),
  );
});

test("a value with a lone dollar, brace or closing braces is not an expression opener", () => {
  assert.equal(render("a: <<n>>\n", { n: "$HOME {x} }} $( ) {{" }), "a: $HOME {x} }} $( ) {{\n");
});

test("two values that meet at an opener are refused: neither holds one alone, the output does", () => {
  assert.throws(
    () => render("run: echo <<a>><<b>>\n", { a: "$", b: "{{ github.event.pull_request.title }}" }),
    (error) => error instanceof RenderError && error.message.includes(OPENER),
  );
});

test("a value that completes an opener against the template's own literal text is refused", () => {
  assert.throws(() => render("run: echo $<<b>>\n", { b: "{{ x }}" }), RenderError);
  assert.throws(() => render("run: echo <<a>>{{ x }}\n", { a: "$" }), RenderError);
  assert.throws(() => render("run: echo $<<a>>{ x }}\n", { a: "{" }), RenderError);
});

test("a fragment line that ends in a dollar followed by a fragment line starting with braces is not an opener", () => {
  // Lines are separated by a newline, so no opener forms across them.
  const template = ["        run: |", "<<gate_script>>", ""].join("\n");
  assert.equal(render(template, { gate_script: "echo $\n{{ x }}" }), ["        run: |", "          echo $", "          {{ x }}", ""].join("\n"));
});

test("the template's own expressions are rendered untouched, including one that wraps a placeholder", () => {
  const template = [
    "group: ci-${{ github.event.pull_request.number }}",
    "secrets:",
    "  <<input>>: ${{ secrets.<<secret>> }}",
    "",
  ].join("\n");
  assert.equal(
    render(template, { input: "claude_code_oauth_token", secret: "CLAUDE_CODE_OAUTH_TOKEN" }),
    [
      "group: ci-${{ github.event.pull_request.number }}",
      "secrets:",
      "  claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
      "",
    ].join("\n"),
  );
});

test("a template expression does not excuse a second one a value adds", () => {
  const template = "a: ${{ x }} <<n>>\n";
  assert.throws(() => render(template, { n: `${OPENER} y }}` }), RenderError);
  assert.throws(() => render("a: ${{ x }} $<<n>>\n", { n: "{{ y }}" }), RenderError);
});

test("a value that is not a string is refused", () => {
  for (const value of [1, null, undefined, true, ["a"], { toString: () => "ok" }]) {
    assert.throws(
      () => render("a: <<n>>\n", { n: value }),
      (error) => error instanceof RenderError && error.message.includes("<<n>>"),
      String(value),
    );
  }
});

// --- Line breaks and control characters ---
// YAML reads a bare CR (and, in YAML 1.1, NEL and the Unicode line and
// paragraph separators) as a line break, so an inline value carrying one can
// start a new key. A value is text with LF line breaks and tabs only.

const BREAKS = [
  ["a carriage return", "\r"],
  ["a next-line character", "\u0085"],
  ["a line separator", "\u2028"],
  ["a paragraph separator", "\u2029"],
  ["a NUL", "\u0000"],
  ["a vertical tab", "\u000b"],
  ["a form feed", "\u000c"],
  ["an escape", "\u001b"],
  ["a delete", "\u007f"],
];

for (const [name, character] of BREAKS) {
  test(`an inline value containing ${name} is refused, naming the key`, () => {
    assert.throws(
      () => render("name: <<n>>\n", { n: `x${character}    if: github.event.pull_request.title == 'go'` }),
      (error) => error instanceof RenderError && error.message.includes("<<n>>") && /control or line-break character/.test(error.message),
    );
  });

  test(`a whole-line value and a fragment containing ${name} are refused`, () => {
    assert.throws(() => render("jobs:\n<<job>>\n", { job: `  a:${character}\n  b:` }), RenderError);
    assert.throws(() => render("        run: |\n<<gate_script>>\n", { gate_script: `echo one\necho two${character}` }), RenderError);
  });
}

test("a value may hold tabs and LF line breaks in a fragment, and any printable character", () => {
  assert.equal(render("name: <<n>>\n", { n: "a\tb caf\u00e9 ~" }), "name: a\tb caf\u00e9 ~\n");
  assert.equal(render("        run: |\n<<s>>\n", { s: "echo a\n\techo b" }), "        run: |\n          echo a\n          \techo b\n");
});
