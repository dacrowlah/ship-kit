import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkSchema } from "../../scripts/lib/schema.mjs";
import { loadConfig } from "../../scripts/lib/config.mjs";
import { MODEL_ID, pinnedModel } from "../helpers/pressure.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const SCHEMA = JSON.parse(read("schemas/config.schema.json"));

/** The JSON example in design 5.1: the first ```json fence after the heading, up to its closing fence. */
function designExample() {
  const design = read("docs/design/ship-kit-design.md");
  const section = design.slice(design.indexOf("\n### 5.1 "));
  const start = section.indexOf("```json\n") + "```json\n".length;
  return section.slice(start, section.indexOf("\n```", start));
}

/** Every [pointer, schema] pair in the schema, depth first. */
function* nodes(schema, pointer = "") {
  yield [pointer, schema];
  for (const [key, sub] of Object.entries(schema.properties ?? {})) yield* nodes(sub, `${pointer}/properties/${key}`);
  for (const key of ["items", "propertyNames", "additionalProperties"]) {
    if (schema[key] !== undefined && schema[key] !== false) yield* nodes(schema[key], `${pointer}/${key}`);
  }
}

test("the config schema passes checkSchema and declares draft 2020-12", () => {
  checkSchema(SCHEMA);
  assert.equal(SCHEMA.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(SCHEMA.required, ["schemaVersion", "shipKit"]);
});

test("every object refuses unknown keys unless it maps names to values", () => {
  for (const [pointer, node] of nodes(SCHEMA)) {
    const isObject = node.type === "object" || (Array.isArray(node.type) && node.type.includes("object"));
    if (!isObject) continue;
    if (pointer === "/properties/preflight/properties/prerequisites") {
      assert.equal(typeof node.additionalProperties, "object", pointer);
      assert.equal(typeof node.propertyNames, "object", pointer);
    } else {
      assert.equal(node.additionalProperties, false, pointer);
    }
  }
});

test("every key outside a required list has a default", () => {
  for (const [pointer, node] of nodes(SCHEMA)) {
    const required = new Set(node.required ?? []);
    for (const [key, sub] of Object.entries(node.properties ?? {})) {
      if (!required.has(key)) assert.ok(Object.hasOwn(sub, "default"), `${pointer}/properties/${key} has no default`);
    }
  }
});

test("the JSON example in design 5.1 validates", () => {
  const text = designExample();
  assert.match(text, /"confirmedLabel": "ship-kit-confirmed"/);
  const result = loadConfig(text);
  assert.equal(result.ok, true, result.reason);
});

test("the design example's check names are the schema's defaults", () => {
  const example = JSON.parse(designExample());
  const defaults = Object.fromEntries(Object.entries(SCHEMA.properties.render.properties.checks.properties).map(([k, v]) => [k, v.default]));
  assert.deepEqual(example.render.checks, defaults);
  assert.deepEqual(loadConfig(designExample()).config.review.promotion, example.review.promotion);
});

const PIN = pinnedModel(ROOT);

test("the review.model default equals the pinned model", () => {
  const model = SCHEMA.properties.review.properties.model;
  assert.equal(model.type, "string");
  assert.equal(model.default, PIN);
  assert.equal(loadConfig(JSON.stringify({ schemaVersion: 1, shipKit: { version: "0.2.0", sha: "0".repeat(40) } })).config.review.model, PIN);
});

test("review.model and every seat's model share one pattern that starts with a letter or digit, and the pin matches it", () => {
  const { model, seats } = SCHEMA.properties.review.properties;
  assert.equal(model.pattern, "^[A-Za-z0-9][A-Za-z0-9._\\[\\]-]{0,99}$");
  assert.equal(MODEL_ID.source, model.pattern);
  assert.deepEqual(Object.keys(seats.properties), ["general", "adversarial", "security", "test-integrity"]);
  for (const [seat, node] of Object.entries(seats.properties)) {
    assert.equal(node.properties.model.pattern, model.pattern, seat);
    assert.deepEqual(node.properties.model.type, ["null", "string"], seat);
    assert.equal(node.properties.model.default, null, seat);
  }
  assert.match(PIN, new RegExp(model.pattern, "u"));
});

test("the design 5.1 example names the pinned model as review.model", () => {
  const example = JSON.parse(designExample());
  assert.equal(example.review.model, PIN);
  assert.equal(loadConfig(designExample()).config.review.model, PIN);
  assert.equal(SCHEMA.properties.review.properties.model.default, example.review.model);
});

test("ship-kit's own .ship-kit/config.json validates with the agreed values", () => {
  const result = loadConfig(read(".ship-kit/config.json"));
  assert.equal(result.ok, true, result.reason);
  const { config } = result;
  assert.equal(config.shipKit.version, "0.1.0");
  assert.deepEqual(config.review.specDirs, ["docs/design/"]);
  assert.deepEqual(config.review.planDirs, ["docs/plans/"]);
  assert.equal(config.review.seats.general.mode, "required");
  assert.equal(config.review.seats.adversarial.mode, "required");
});

test("ship-kit's own .claude/settings.json pins the released marketplace and enables the plugin", () => {
  const settings = JSON.parse(read(".claude/settings.json"));
  assert.deepEqual(settings, {
    extraKnownMarketplaces: {
      "ship-kit": { source: { source: "github", repo: "dacrowlah/ship-kit", ref: "ship-kit--v0.1.0" } },
      "claude-plugins-official": { source: { source: "github", repo: "anthropics/claude-plugins-official" } },
    },
    enabledPlugins: { "ship-kit@ship-kit": true },
  });
});

test("every schema pattern finishes in under 50 ms on adversarial 10,000-character input", () => {
  const inputs = [
    `${"a".repeat(9999)}!`,
    "./".repeat(5000),
    `${"a/".repeat(5000)}..`,
    `${"A".repeat(9999)}!`,
    `${"A_".repeat(4999)}a!`,
    `${"a.".repeat(4999)}a!`,
    `${"[".repeat(9999)}!`,
    `${".a/".repeat(3333)}!`,
    `${"a ".repeat(4999)}a:`,
    `${"1.".repeat(4999)}x`,
  ];
  const patterns = [...nodes(SCHEMA)].filter(([, node]) => typeof node.pattern === "string").map(([pointer, node]) => [pointer, node.pattern]);
  const names = patterns.map(([pointer]) => pointer).join("\n");
  assert.match(names, /secret/);
  assert.match(names, /model/);
  assert.match(names, /specDirs/);
  assert.ok(patterns.some(([pointer]) => pointer === "/properties/review/properties/model"), "review.model has a pattern under test");
  for (const [pointer, pattern] of patterns) {
    const re = new RegExp(pattern, "u");
    for (const input of inputs) {
      const started = process.hrtime.bigint();
      re.test(input);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      assert.ok(ms < 50, `${pointer} took ${ms} ms on a ${input.length}-character input`);
    }
  }
});
