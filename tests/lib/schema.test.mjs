import assert from "node:assert/strict";
import test from "node:test";
import { SUPPORTED_KEYWORDS, SchemaError, checkSchema, validate } from "../../scripts/lib/schema.mjs";

function nestedArraySchema(depth) {
  let schema = {};
  for (let i = 0; i < depth; i += 1) schema = { type: "array", items: schema };
  return schema;
}

function nestedArrayValue(depth) {
  let value = [];
  for (let i = 0; i < depth; i += 1) value = [value];
  return value;
}

test("SUPPORTED_KEYWORDS is exactly the documented subset", () => {
  assert.deepEqual(
    [...SUPPORTED_KEYWORDS].sort(),
    [
      "$id", "$schema", "additionalProperties", "const", "default", "description",
      "enum", "items", "maxItems", "maxLength", "maximum", "minItems", "minimum",
      "pattern", "properties", "propertyNames", "required", "title", "type",
    ].sort(),
  );
});

test("checkSchema refuses oneOf nested three levels down", () => {
  const schema = {
    type: "object",
    properties: {
      a: {
        type: "object",
        properties: {
          b: {
            type: "object",
            properties: {
              c: { oneOf: [{ type: "string" }] },
            },
          },
        },
      },
    },
  };
  assert.throws(() => checkSchema(schema), (err) => {
    assert.ok(err instanceof SchemaError);
    assert.match(err.message, /\/properties\/a\/properties\/b\/properties\/c/);
    assert.match(err.message, /oneOf/);
    return true;
  });
});

test("checkSchema refuses additionalProperties: true", () => {
  assert.throws(() => checkSchema({ type: "object", additionalProperties: true }), SchemaError);
});

test("checkSchema accepts additionalProperties: false and a schema", () => {
  assert.doesNotThrow(() => checkSchema({ type: "object", additionalProperties: false }));
  assert.doesNotThrow(() => checkSchema({ type: "object", additionalProperties: { type: "string" } }));
});

test("checkSchema refuses an unanchored pattern", () => {
  assert.throws(() => checkSchema({ type: "string", pattern: "a+" }), SchemaError);
  assert.doesNotThrow(() => checkSchema({ type: "string", pattern: "^a+$" }));
});

test("checkSchema refuses a pattern that does not compile", () => {
  assert.throws(() => checkSchema({ type: "string", pattern: "^(a$" }), SchemaError);
});

test("checkSchema refuses a default that violates its schema", () => {
  assert.throws(() => checkSchema({ type: "number", minimum: 5, default: 1 }), SchemaError);
});

test("checkSchema accepts a default that satisfies its schema", () => {
  assert.doesNotThrow(() => checkSchema({ type: "number", minimum: 5, default: 10 }));
});

test("checkSchema refuses an unsupported type name", () => {
  assert.throws(() => checkSchema({ type: "function" }), SchemaError);
});

test("checkSchema refuses a schema deeper than the maximum depth", () => {
  assert.throws(() => checkSchema(nestedArraySchema(1000)), SchemaError);
});

test("a missing property gets its default, deep-copied", () => {
  const schema = {
    type: "object",
    properties: {
      tags: { type: "array", default: [] },
    },
  };
  const result = validate(schema, {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { tags: [] });
  result.value.tags.push("mutated");
  assert.deepEqual(schema.properties.tags.default, []);
});

test("an object default fills nested defaults", () => {
  const schema = {
    type: "object",
    properties: {
      a: {
        type: "object",
        default: {},
        properties: {
          b: { type: "number", default: 1 },
        },
      },
    },
  };
  const result = validate(schema, {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { a: { b: 1 } });
});

test("additionalProperties false rejects __proto__ and constructor keys", () => {
  const schema = { type: "object", properties: {}, additionalProperties: false };
  const value = JSON.parse('{"__proto__": "polluted", "constructor": "polluted"}');
  assert.equal(Object.hasOwn(value, "__proto__"), true);
  const result = validate(schema, value);
  assert.equal(result.ok, false);
  const paths = result.errors.map((e) => e.path).sort();
  assert.deepEqual(paths, ["/__proto__", "/constructor"]);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
  assert.equal(Object.prototype.polluted, undefined);
});

test("additionalProperties as a schema validates each extra value", () => {
  const schema = {
    type: "object",
    properties: {},
    additionalProperties: { type: "array", items: { type: "string" } },
  };
  const ok = validate(schema, { fruits: ["apple", "banana"] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { fruits: ["apple", "banana"] });

  const bad = validate(schema, { fruits: ["apple", 2] });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors[0].path, "/fruits/1");
});

test("propertyNames pattern applies to every key", () => {
  const schema = {
    type: "object",
    propertyNames: { type: "string", pattern: "^[a-z]+$" },
    additionalProperties: { type: "number" },
  };
  const result = validate(schema, { good: 1, "Bad-Key": 2 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "/Bad-Key"));
});

test("integer rejects 1.5 and accepts 1", () => {
  const schema = { type: "integer" };
  assert.equal(validate(schema, 1.5).ok, false);
  assert.equal(validate(schema, 1).ok, true);
});

test("type arrays admit null", () => {
  const schema = { type: ["number", "null"] };
  assert.equal(validate(schema, null).ok, true);
  assert.equal(validate(schema, 5).ok, true);
  assert.equal(validate(schema, "x").ok, false);
});

test("enum and const compare deeply", () => {
  const constSchema = { const: { a: 1, b: [1, 2] } };
  assert.equal(validate(constSchema, { b: [1, 2], a: 1 }).ok, true);
  assert.equal(validate(constSchema, { a: 1, b: [1, 3] }).ok, false);

  const enumSchema = { enum: [{ x: 1 }, { x: 2 }] };
  assert.equal(validate(enumSchema, { x: 2 }).ok, true);
  assert.equal(validate(enumSchema, { x: 3 }).ok, false);
});

test("minItems, maxItems, maxLength bound inputs", () => {
  const arraySchema = { type: "array", minItems: 2, maxItems: 3 };
  assert.equal(validate(arraySchema, [1, 1]).ok, true);
  assert.equal(validate(arraySchema, [1]).ok, false);
  assert.equal(validate(arraySchema, [1, 1, 1]).ok, true);
  assert.equal(validate(arraySchema, [1, 1, 1, 1]).ok, false);

  const stringSchema = { type: "string", maxLength: 3 };
  assert.equal(validate(stringSchema, "abc").ok, true);
  assert.equal(validate(stringSchema, "abcd").ok, false);
});

test("depth over 64 is an error, not a stack overflow", () => {
  const deepSchema = nestedArraySchema(1000);
  assert.throws(() => checkSchema(deepSchema), SchemaError);

  const deepValue = nestedArrayValue(1000);
  const result = validate(deepSchema, deepValue);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /maximum schema depth/.test(e.message)));
});

test("every error carries a JSON pointer path", () => {
  const schema = {
    type: "object",
    properties: {
      review: {
        type: "object",
        properties: {
          seats: {
            type: "object",
            properties: {
              general: {
                type: "object",
                properties: {
                  mode: { type: "string", enum: ["required", "shadow", "off"] },
                },
              },
            },
          },
        },
      },
    },
  };
  const value = { review: { seats: { general: { mode: 123 } } } };
  const result = validate(schema, value);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "/review/seats/general/mode"));
});

test("checkSchema refuses a non-string pattern", () => {
  assert.throws(() => checkSchema({ type: "string", pattern: 42 }), SchemaError);
});

test("checkSchema refuses an empty type array", () => {
  assert.throws(() => checkSchema({ type: [] }), SchemaError);
});

test("checkSchema refuses a non-numeric minimum", () => {
  assert.throws(() => checkSchema({ type: "number", minimum: "5" }), SchemaError);
});

test("checkSchema refuses a required list that is not an array of strings", () => {
  assert.throws(() => checkSchema({ type: "object", required: ["a", 1] }), SchemaError);
  assert.throws(() => checkSchema({ type: "object", required: "a" }), SchemaError);
});

test("checkSchema refuses a schema that is not an object", () => {
  assert.throws(() => checkSchema("not a schema"), SchemaError);
  assert.throws(() => checkSchema(null), SchemaError);
});

test("checkSchema refuses a non-object properties value", () => {
  assert.throws(() => checkSchema({ type: "object", properties: "nope" }), SchemaError);
});

test("checkSchema walks a propertyNames subschema", () => {
  assert.doesNotThrow(() => checkSchema({ type: "object", propertyNames: { type: "string", pattern: "^[a-z]+$" } }));
  assert.throws(
    () => checkSchema({ type: "object", propertyNames: { type: "string", pattern: "a+" } }),
    SchemaError,
  );
});

test("checkSchema refuses a non-array enum", () => {
  assert.throws(() => checkSchema({ enum: "not-an-array" }), SchemaError);
});

test("minimum and maximum bound numbers", () => {
  const schema = { type: "number", minimum: 1, maximum: 3 };
  assert.equal(validate(schema, 1).ok, true);
  assert.equal(validate(schema, 0).ok, false);
  assert.equal(validate(schema, 3).ok, true);
  assert.equal(validate(schema, 4).ok, false);
});

test("a required property missing after default-filling is an error", () => {
  const schema = {
    type: "object",
    required: ["name"],
    properties: { name: { type: "string" } },
  };
  const result = validate(schema, {});
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{ path: "/name", message: "is required" }]);
});

test("a required property filled by a default satisfies required", () => {
  const schema = {
    type: "object",
    required: ["name"],
    properties: { name: { type: "string", default: "anon" } },
  };
  const result = validate(schema, {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { name: "anon" });
});

test("a value's own extra properties are deep-copied when no additionalProperties keyword is present", () => {
  const schema = { type: "object", properties: { a: { type: "number" } } };
  const nested = { list: [1, 2] };
  const value = { a: 1, extra: nested };
  const result = validate(schema, value);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { a: 1, extra: { list: [1, 2] } });
  result.value.extra.list.push(3);
  assert.deepEqual(nested.list, [1, 2]);
});
