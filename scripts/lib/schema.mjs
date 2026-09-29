// A JSON Schema *subset* interpreter: only the keywords ship-kit's config
// schema uses. `checkSchema` rejects a schema document that uses anything
// outside the subset (or misuses a supported keyword) so a second,
// hand-written copy of the validation rules never drifts from what this
// file actually enforces. `validate` applies a checked schema to a value,
// filling `default`s and returning a value built from plain, JSON-shaped
// objects: it never trusts `value`'s own prototype chain.

export class SchemaError extends Error {}

const TYPE_NAMES = new Set([
  "object", "array", "string", "integer", "number", "boolean", "null",
]);

export const SUPPORTED_KEYWORDS = new Set([
  "type", "enum", "const", "required", "properties", "additionalProperties",
  "items", "pattern", "minimum", "maximum", "minItems", "maxItems", "maxLength",
  "propertyNames", "default",
  "$schema", "$id", "title", "description",
]);

const MAX_DEPTH = 64;
const NUMERIC_KEYWORDS = ["minimum", "maximum", "minItems", "maxItems", "maxLength"];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Builds an own data property without ever invoking a `__proto__` setter. */
function setOwn(target, key, value) {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
  return target;
}

function pointerAppend(path, segment) {
  const escaped = String(segment).replace(/~/g, "~0").replace(/\//g, "~1");
  return `${path}/${escaped}`;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length
      && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    return ak.length === bk.length && ak.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function matchesType(value, typeName) {
  switch (typeName) {
    case "object": return isPlainObject(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number";
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: return false;
  }
}

function typeList(schema) {
  if (!Object.hasOwn(schema, "type")) return null;
  return Array.isArray(schema.type) ? schema.type : [schema.type];
}

// --- checkSchema -----------------------------------------------------------

function checkPattern(pattern, path) {
  if (typeof pattern !== "string") {
    throw new SchemaError(`${path}/pattern: must be a string`);
  }
  if (!pattern.startsWith("^") || !pattern.endsWith("$")) {
    throw new SchemaError(`${path}/pattern: must be anchored with ^ and $ (got ${JSON.stringify(pattern)})`);
  }
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern, "u");
  } catch (err) {
    throw new SchemaError(`${path}/pattern: invalid pattern ${JSON.stringify(pattern)}: ${err.message}`);
  }
}

function checkTypeKeyword(schema, path) {
  const names = typeList(schema);
  if (names === null) return;
  if (!Array.isArray(names) || names.length === 0) {
    throw new SchemaError(`${path}/type: must be a type name or a non-empty array of type names`);
  }
  for (const name of names) {
    if (typeof name !== "string" || !TYPE_NAMES.has(name)) {
      throw new SchemaError(`${path}/type: unsupported type ${JSON.stringify(name)}`);
    }
  }
}

function checkNumericKeywords(schema, path) {
  for (const key of NUMERIC_KEYWORDS) {
    if (Object.hasOwn(schema, key) && typeof schema[key] !== "number") {
      throw new SchemaError(`${path}/${key}: must be a number`);
    }
  }
}

function checkRequiredKeyword(schema, path) {
  if (!Object.hasOwn(schema, "required")) return;
  const { required } = schema;
  if (!Array.isArray(required) || !required.every((k) => typeof k === "string")) {
    throw new SchemaError(`${path}/required: must be an array of strings`);
  }
}

function walkSchema(schema, path, depth) {
  if (depth > MAX_DEPTH) {
    throw new SchemaError(`${path || "/"}: schema nesting exceeds the maximum depth of ${MAX_DEPTH}`);
  }
  if (!isPlainObject(schema)) {
    throw new SchemaError(`${path || "/"}: schema must be an object`);
  }
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      throw new SchemaError(`${path || "/"}: unknown keyword ${JSON.stringify(key)}`);
    }
  }

  checkTypeKeyword(schema, path);
  checkNumericKeywords(schema, path);
  checkRequiredKeyword(schema, path);
  if (Object.hasOwn(schema, "pattern")) checkPattern(schema.pattern, path);
  if (Object.hasOwn(schema, "enum") && !Array.isArray(schema.enum)) {
    throw new SchemaError(`${path}/enum: must be an array`);
  }

  if (Object.hasOwn(schema, "properties")) {
    if (!isPlainObject(schema.properties)) {
      throw new SchemaError(`${path}/properties: must be an object`);
    }
    for (const [key, sub] of Object.entries(schema.properties)) {
      walkSchema(sub, pointerAppend(pointerAppend(path, "properties"), key), depth + 1);
    }
  }

  if (Object.hasOwn(schema, "additionalProperties")) {
    const ap = schema.additionalProperties;
    if (ap !== false) {
      if (!isPlainObject(ap)) {
        throw new SchemaError(`${path}/additionalProperties: must be false or a schema`);
      }
      walkSchema(ap, pointerAppend(path, "additionalProperties"), depth + 1);
    }
  }

  if (Object.hasOwn(schema, "propertyNames")) {
    walkSchema(schema.propertyNames, pointerAppend(path, "propertyNames"), depth + 1);
  }

  if (Object.hasOwn(schema, "items")) {
    walkSchema(schema.items, pointerAppend(path, "items"), depth + 1);
  }

  if (Object.hasOwn(schema, "default")) {
    const errors = [];
    validateNode(schema, deepCopy(schema.default), pointerAppend(path, "default"), 0, errors);
    if (errors.length > 0) {
      throw new SchemaError(`${path}/default: default value is invalid at ${errors[0].path}: ${errors[0].message}`);
    }
  }
}

/** @param {unknown} schema @throws {SchemaError} */
export function checkSchema(schema) {
  walkSchema(schema, "", 0);
}

// --- validate ----------------------------------------------------------------

function validateObjectNode(schema, value, path, depth, errors) {
  const props = isPlainObject(schema.properties) ? schema.properties : {};
  const result = {};

  for (const [key, subschema] of Object.entries(props)) {
    const childPath = pointerAppend(path, key);
    if (Object.hasOwn(value, key)) {
      setOwn(result, key, validateNode(subschema, value[key], childPath, depth + 1, errors));
    } else if (Object.hasOwn(subschema, "default")) {
      const withDefault = deepCopy(subschema.default);
      setOwn(result, key, validateNode(subschema, withDefault, childPath, depth + 1, errors));
    }
  }

  if (Object.hasOwn(schema, "required")) {
    for (const key of schema.required) {
      if (!Object.hasOwn(result, key)) {
        errors.push({ path: pointerAppend(path, key), message: "is required" });
      }
    }
  }

  const valueKeys = Object.keys(value);

  if (Object.hasOwn(schema, "propertyNames")) {
    for (const key of valueKeys) {
      validateNode(schema.propertyNames, key, pointerAppend(path, key), depth + 1, errors);
    }
  }

  const extraKeys = valueKeys.filter((key) => !Object.hasOwn(props, key));
  if (Object.hasOwn(schema, "additionalProperties")) {
    const ap = schema.additionalProperties;
    if (ap === false) {
      for (const key of extraKeys) {
        errors.push({ path: pointerAppend(path, key), message: "additional property is not allowed" });
      }
    } else {
      for (const key of extraKeys) {
        setOwn(result, key, validateNode(ap, value[key], pointerAppend(path, key), depth + 1, errors));
      }
    }
  } else {
    for (const key of extraKeys) {
      setOwn(result, key, deepCopy(value[key]));
    }
  }

  return result;
}

function validateArrayNode(schema, value, path, depth, errors) {
  if (Object.hasOwn(schema, "minItems") && value.length < schema.minItems) {
    errors.push({ path, message: `must have at least ${schema.minItems} item(s)` });
  }
  if (Object.hasOwn(schema, "maxItems") && value.length > schema.maxItems) {
    errors.push({ path, message: `must have at most ${schema.maxItems} item(s)` });
  }
  if (!Object.hasOwn(schema, "items")) {
    return value;
  }
  return value.map((item, index) => validateNode(schema.items, item, pointerAppend(path, index), depth + 1, errors));
}

function validateStringNode(schema, value, path, errors) {
  if (Object.hasOwn(schema, "maxLength") && value.length > schema.maxLength) {
    errors.push({ path, message: `must have length at most ${schema.maxLength}` });
  }
  if (Object.hasOwn(schema, "pattern")) {
    const re = new RegExp(schema.pattern, "u");
    if (!re.test(value)) {
      errors.push({ path, message: `must match pattern ${schema.pattern}` });
    }
  }
  return value;
}

function validateNumberNode(schema, value, path, errors) {
  if (Object.hasOwn(schema, "minimum") && value < schema.minimum) {
    errors.push({ path, message: `must be >= ${schema.minimum}` });
  }
  if (Object.hasOwn(schema, "maximum") && value > schema.maximum) {
    errors.push({ path, message: `must be <= ${schema.maximum}` });
  }
  return value;
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (isPlainObject(value)) return "object";
  return typeof value;
}

function validateNode(schema, value, path, depth, errors) {
  if (depth > MAX_DEPTH) {
    errors.push({ path, message: `exceeds the maximum schema depth of ${MAX_DEPTH}` });
    return value;
  }

  const types = typeList(schema);
  if (types !== null && !types.some((t) => matchesType(value, t))) {
    errors.push({ path, message: `must be of type ${types.join(" or ")}` });
    return value;
  }

  if (Object.hasOwn(schema, "const") && !deepEqual(schema.const, value)) {
    errors.push({ path, message: "does not match const" });
    return value;
  }

  if (Object.hasOwn(schema, "enum") && !schema.enum.some((e) => deepEqual(e, value))) {
    errors.push({ path, message: "does not match enum" });
    return value;
  }

  switch (typeOf(value)) {
    case "object":
      return validateObjectNode(schema, value, path, depth, errors);
    case "array":
      return validateArrayNode(schema, value, path, depth, errors);
    case "string":
      return validateStringNode(schema, value, path, errors);
    case "number":
      return validateNumberNode(schema, value, path, errors);
    default:
      return value;
  }
}

/**
 * @param {unknown} schema a schema already accepted by `checkSchema`
 * @param {unknown} value
 * @returns {{ok: true, value: unknown} | {ok: false, errors: {path: string, message: string}[]}}
 */
export function validate(schema, value) {
  const errors = [];
  const result = validateNode(schema, value, "", 0, errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: result };
}
