#!/usr/bin/env node
// Writes one seat's receipt (design 6.3 seat step 4; rulings 13, 43): the
// seat's structured output, read from the claude-code-action execution
// file, so an output of any size arrives whole (an environment variable is
// capped at 128 KiB on Linux). The execution file itself is never uploaded;
// only this receipt is.
//
// `body` is the last `type: "result"` message's `structured_output` when
// that is a plain object, else null: a missing, oversized, unreadable or
// unparseable file, or a last result without one, is `body: null`, which
// aggregate scores fail-coverage. A body holding anything shaped like a
// credential (inert.mjs anyCredential, object keys included) is never
// written: the receipt is `{index, seat, body: null, withheld: true}`.
//
// Usage: receipt.mjs <index>, with EXECUTION_FILE (may be empty), SEAT and
// OUT_DIR (absolute) in the environment. Writes <OUT_DIR>/receipt.json and
// exits 0; exits 2 on a usage error and 1 when the receipt cannot be written.

import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { anyCredential } from "./inert.mjs";
import { SEATS } from "./review-mode.mjs";

export const MAX_EXECUTION_BYTES = 64 * 1024 * 1024;

const INDEX = /^[1-9][0-9]{0,8}$/;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The seat's structured output from an execution file's text.
 * @param {unknown} text a JSON array of SDK messages
 * @returns {object|null}
 */
export function readExecutionBody(text) {
  if (typeof text !== "string") return null;
  let messages;
  try {
    messages = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (isPlainObject(message) && message.type === "result") {
      return isPlainObject(message.structured_output) ? message.structured_output : null;
    }
  }
  return null;
}

/** The file's text when it is a regular file of at most MAX_EXECUTION_BYTES; null otherwise. */
function readExecutionFile(path) {
  if (typeof path !== "string" || path === "") return null;
  let fd;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_EXECUTION_BYTES) return null;
    return readFileSync(fd).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * @param {string[]} [argv] exactly one positive integer index
 * @param {Record<string, string|undefined>} [env]
 * @param {{err: {write: Function}}} [io]
 * @returns {number} exit code
 */
export function main(argv = process.argv.slice(2), env = process.env, io = { err: process.stderr }) {
  const usage = (why) => {
    io.err.write(`receipt: ${why}\nusage: receipt.mjs <index> with EXECUTION_FILE, SEAT and OUT_DIR set\n`);
    return 2;
  };
  if (argv.length !== 1 || !INDEX.test(argv[0])) return usage("the index must be one positive integer");
  if (!SEATS.includes(env.SEAT)) return usage(`SEAT must be one of ${SEATS.join(", ")}`);
  if (typeof env.OUT_DIR !== "string" || !isAbsolute(env.OUT_DIR)) return usage("OUT_DIR must be an absolute path");

  const index = Number(argv[0]);
  const seat = env.SEAT;
  const body = readExecutionBody(readExecutionFile(env.EXECUTION_FILE));
  const receipt = body !== null && anyCredential(body) ? { index, seat, body: null, withheld: true } : { index, seat, body };
  try {
    mkdirSync(env.OUT_DIR, { recursive: true });
    writeFileSync(join(env.OUT_DIR, "receipt.json"), `${JSON.stringify(receipt)}\n`);
  } catch (error) {
    io.err.write(`receipt: could not write ${join(env.OUT_DIR, "receipt.json")}: ${error.message}\n`);
    return 1;
  }
  return 0;
}

function isEntry() {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
}

if (isEntry()) {
  process.exitCode = main();
}
