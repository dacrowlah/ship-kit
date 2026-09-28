import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO = fileURLToPath(new URL("..", import.meta.url));

/** @param {Buffer} bytes @returns {{line: number, byte: number}[]} bytes outside printable ASCII, tab and newline */
export function findNonAscii(bytes) {
  const found = [];
  let line = 1;
  for (const byte of bytes) {
    if (byte === 0x0a) {
      line += 1;
      continue;
    }
    if (byte !== 0x09 && (byte < 0x20 || byte > 0x7e)) found.push({ line, byte });
  }
  return found;
}

test("findNonAscii accepts printable ASCII, tab and newline", () => {
  assert.deepEqual(findNonAscii(Buffer.from("a\tb ~\n}\n", "utf8")), []);
});

test("findNonAscii reports an em dash, a carriage return and a NUL by line", () => {
  const emDash = String.fromCharCode(0x2014);
  const found = findNonAscii(Buffer.from(`ok\na ${emDash} b\nc\r\n` + String.fromCharCode(0), "utf8"));
  assert.deepEqual(found.map((f) => f.line), [2, 2, 2, 3, 4]);
});

test("every tracked file is ASCII", () => {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  assert.ok(files.length > 0, "git ls-files returned nothing");
  const violations = files.flatMap((file) =>
    findNonAscii(readFileSync(join(REPO, file))).map(
      ({ line, byte }) => `${file}:${line}: byte 0x${byte.toString(16).padStart(2, "0")}`,
    ),
  );
  assert.deepEqual(violations, []);
});
