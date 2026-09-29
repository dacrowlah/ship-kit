import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findKeyOccurrences, parseYaml, YamlSubsetError } from "./yaml.mjs";
import { renderedTemplateVariants } from "./rendered-templates.mjs";

test("comments are ignored", () => {
  const text = ["# a leading comment", "foo: bar # a trailing comment", "# a trailing comment line"].join("\n");
  assert.deepEqual(parseYaml(text), { foo: "bar" });
});

test("a comment mark inside a quoted scalar is not a comment", () => {
  assert.deepEqual(parseYaml('foo: "a # b"'), { foo: "a # b" });
});

test("a block mapping parses each key to its value", () => {
  const text = ["a: 1", "b: two", "c: true"].join("\n");
  assert.deepEqual(parseYaml(text), { a: 1, b: "two", c: true });
});

test("a nested block mapping parses under its key", () => {
  const text = ["outer:", "  inner: 1", "  other: 2"].join("\n");
  assert.deepEqual(parseYaml(text), { outer: { inner: 1, other: 2 } });
});

test("a block sequence of scalars parses to an array", () => {
  const text = ["- a", "- b", "- c"].join("\n");
  assert.deepEqual(parseYaml(text), ["a", "b", "c"]);
});

test("a sequence nested under a key at the key's own indentation parses", () => {
  const text = ["foo:", "- a", "- b"].join("\n");
  assert.deepEqual(parseYaml(text), { foo: ["a", "b"] });
});

test("a sequence nested under a key at deeper indentation parses", () => {
  const text = ["foo:", "  - a", "  - b"].join("\n");
  assert.deepEqual(parseYaml(text), { foo: ["a", "b"] });
});

test("mapping items inside a sequence parse, spanning multiple lines", () => {
  const text = ["- name: one", "  value: 1", "- name: two", "  value: 2"].join("\n");
  assert.deepEqual(parseYaml(text), [
    { name: "one", value: 1 },
    { name: "two", value: 2 },
  ]);
});

test("a mapping item in a sequence can itself hold a nested mapping", () => {
  const text = ["- name: one", "  with:", "    x: 1", "    y: 2"].join("\n");
  assert.deepEqual(parseYaml(text), [{ name: "one", with: { x: 1, y: 2 } }]);
});

for (const [text, expected] of [
  ["a: true", true],
  ["a: false", false],
  ["a: null", null],
  ["a: ~", null],
  ["a: 0", 0],
  ["a: 42", 42],
  ["a: -7", -7],
  ["a: hello world", "hello world"],
  ["a: 1.7.12", "1.7.12"],
]) {
  test(`plain scalar ${JSON.stringify(text)} reads as ${JSON.stringify(expected)}`, () => {
    assert.deepEqual(parseYaml(text), { a: expected });
  });
}

test("a single-quoted scalar reads literally, with '' as an escaped quote", () => {
  assert.deepEqual(parseYaml("a: 'it''s'"), { a: "it's" });
});

test("a double-quoted scalar decodes \\\\, \\\", \\n and \\t", () => {
  assert.deepEqual(parseYaml('a: "a\\\\b\\"c\\nd\\te"'), { a: 'a\\b"c\nd\te' });
});

test("a flow sequence of scalars parses to an array", () => {
  assert.deepEqual(parseYaml("a: [main, dev, 1]"), { a: ["main", "dev", 1] });
});

test("a single-item flow sequence parses to a one-element array", () => {
  assert.deepEqual(parseYaml("a: [main]"), { a: ["main"] });
});

test("an empty flow mapping parses to an empty object", () => {
  assert.deepEqual(parseYaml("a: {}"), { a: {} });
});

test("an empty flow sequence parses to an empty array", () => {
  assert.deepEqual(parseYaml("a: []"), { a: [] });
});

test("a literal block scalar with | keeps one trailing newline", () => {
  const text = ["a: |", "  line one", "  line two"].join("\n");
  assert.deepEqual(parseYaml(text), { a: "line one\nline two\n" });
});

test("a literal block scalar with |- strips the trailing newline", () => {
  const text = ["a: |-", "  line one", "  line two"].join("\n");
  assert.deepEqual(parseYaml(text), { a: "line one\nline two" });
});

test("a literal block scalar keeps blank lines and a leading # as content", () => {
  const text = ["a: |", "  first", "", "  # not a comment", "  last"].join("\n");
  assert.deepEqual(parseYaml(text), { a: "first\n\n# not a comment\nlast\n" });
});

test("a literal block scalar ends at the first line back at or above the key's indentation", () => {
  const text = ["a: |", "  body", "b: 2"].join("\n");
  assert.deepEqual(parseYaml(text), { a: "body\n", b: 2 });
});

for (const [name, text] of [
  ["an anchor", "a: &x 1"],
  ["an alias", "a: *x"],
  ["a tag", "a: !!str 1"],
  ["a custom tag", "a: !Foo 1"],
  ["a folded scalar", "a: >\n  hi"],
  ["a non-empty flow mapping", "a: {b: 1}"],
]) {
  test(`${name} is refused`, () => {
    assert.throws(() => parseYaml(text), YamlSubsetError);
  });
}

test("multiple documents are refused", () => {
  const text = ["a: 1", "---", "b: 2"].join("\n");
  assert.throws(() => parseYaml(text), YamlSubsetError);
});

test("a single leading document marker is accepted", () => {
  const text = ["---", "a: 1"].join("\n");
  assert.deepEqual(parseYaml(text), { a: 1 });
});

test("duplicate keys are refused", () => {
  const text = ["a: 1", "a: 2"].join("\n");
  assert.throws(() => parseYaml(text), YamlSubsetError);
});

test("tabs in indentation are refused", () => {
  const text = "a:\n\tb: 1";
  assert.throws(() => parseYaml(text), YamlSubsetError);
});

test("an empty document parses to null", () => {
  assert.equal(parseYaml(""), null);
  assert.equal(parseYaml("# only a comment\n"), null);
});

function hasYq() {
  const result = spawnSync("yq", ["--version"], { encoding: "utf8" });
  return result.status === 0;
}

// Real, complete workflow files and YAML fixtures only: a caller template
// under templates/ may hold `<<placeholder>>` tokens (for example a column-0
// whole-line placeholder standing in for an entire job), which are not valid
// YAML on their own, so `yq` cannot parse it and it is not part of this
// cross-check. A rendered template (placeholders filled in, via the same
// registered renderers `tests/workflows/no-expression-in-run.test.mjs` uses
// for its expression gate) is real YAML and is cross-checked separately,
// below.
const yamlFixtures = [...globSync(".github/workflows/*.yml"), ...globSync("tests/fixtures/**/*.yml")].filter((path) =>
  existsSync(path),
);

/**
 * Recursively collects the value of every key named in `keyNames`, from any
 * plain-object node at any depth of a value tree such as `yq -o=json`'s
 * output (used as the oracle `findKeyOccurrences` is checked against).
 * @param {unknown} value
 * @param {Set<string>} keyNames
 * @param {unknown[]} sink
 * @returns {unknown[]}
 */
function collectKeysDeep(value, keyNames, sink = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeysDeep(item, keyNames, sink);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (keyNames.has(key)) sink.push(child);
      collectKeysDeep(child, keyNames, sink);
    }
  }
  return sink;
}

if (!hasYq()) {
  if (process.env.CI) {
    test("parse matches yq on every workflow (yq is required in CI)", () => {
      assert.fail("yq is not installed; the cross-check against a real YAML parser did not run");
    });
  } else {
    test("parse matches yq on every workflow (skipped: yq is not installed locally)", { skip: true }, () => {});
  }
} else {
  for (const path of yamlFixtures) {
    test(`parse matches yq on every workflow: ${path}`, () => {
      const text = readFileSync(path, "utf8");
      const yqResult = spawnSync("yq", ["-o=json", path], { encoding: "utf8" });
      assert.equal(yqResult.status, 0, `yq failed on ${path}: ${yqResult.stderr}`);
      const expected = JSON.parse(yqResult.stdout);
      assert.deepEqual(parseYaml(text), expected);
    });

    test(`findKeyOccurrences' run/script values match yq's on every workflow: ${path}`, () => {
      const text = readFileSync(path, "utf8");
      const yqResult = spawnSync("yq", ["-o=json", path], { encoding: "utf8" });
      assert.equal(yqResult.status, 0, `yq failed on ${path}: ${yqResult.stderr}`);
      const expected = JSON.parse(yqResult.stdout);
      const keyNames = new Set(["run", "script"]);
      const fromYq = collectKeysDeep(expected, keyNames).sort();
      const fromWalk = findKeyOccurrences(text, ["run", "script"])
        .map((occurrence) => occurrence.value)
        .sort();
      assert.deepEqual(fromWalk, fromYq);
    });
  }
}

// -- Rendered templates: placeholders filled in with representative values
// (`tests/helpers/rendered-templates.mjs`), so the result is real,
// standalone YAML the same way a workflow file already is, then
// cross-checked against yq the same way. ---------------------------------

if (hasYq()) {
  for (const { path, variant, text } of renderedTemplateVariants()) {
    test(`parse matches yq on a rendered template: ${path} [${variant}]`, () => {
      const dir = mkdtempSync(join(tmpdir(), "ship-kit-yaml-yq-"));
      try {
        const rendered = join(dir, "rendered.yml");
        writeFileSync(rendered, text);
        const yqResult = spawnSync("yq", ["-o=json", rendered], { encoding: "utf8" });
        assert.equal(yqResult.status, 0, `yq failed on rendered ${path} [${variant}]: ${yqResult.stderr}`);
        const expected = JSON.parse(yqResult.stdout);
        assert.deepEqual(parseYaml(text), expected);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
} else if (process.env.CI) {
  test("parse matches yq on every rendered template (yq is required in CI)", () => {
    assert.fail("yq is not installed; the cross-check against a real YAML parser did not run");
  });
} else {
  test("parse matches yq on every rendered template (skipped: yq is not installed locally)", { skip: true }, () => {});
}
