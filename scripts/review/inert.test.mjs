import assert from "node:assert/strict";
import test from "node:test";
import {
  fence, credentialLike, anyCredential, truncate, TRUNCATED,
} from "./inert.mjs";

const BT = "`";

/** Splits a fenced block into its opening fence, body and closing fence. */
function parts(fenced) {
  const lines = fenced.split("\n");
  return { open: lines[0], body: lines.slice(1, -1).join("\n"), close: lines.at(-1) };
}

test("text with a triple-backtick fence inside gets a 4-backtick fence", () => {
  const text = `before\n${BT.repeat(3)}js\ncode\n${BT.repeat(3)}\nafter`;
  const { open, body, close } = parts(fence(text));
  assert.equal(open, BT.repeat(4));
  assert.equal(close, BT.repeat(4));
  assert.equal(body, text);
});

test("a run of 10 backticks gets an 11-backtick fence", () => {
  const { open, close } = parts(fence(`x ${BT.repeat(10)} y`));
  assert.equal(open, BT.repeat(11));
  assert.equal(close, BT.repeat(11));
});

test("the longest run decides the fence wherever it sits on the line", () => {
  const { open } = parts(fence(`a ${BT} b ${BT.repeat(5)} c ${BT.repeat(2)}`));
  assert.equal(open, BT.repeat(6));
});

test("plain text gets the minimum 3-backtick fence", () => {
  assert.equal(fence("hello"), `${BT.repeat(3)}\nhello\n${BT.repeat(3)}`);
  assert.equal(fence(""), `${BT.repeat(3)}\n\n${BT.repeat(3)}`);
});

test("a trailing newline does not add an empty line before the closing fence", () => {
  assert.equal(fence("hello\n"), `${BT.repeat(3)}\nhello\n${BT.repeat(3)}`);
});

test("mentions, HTML and links all sit inside the fence", () => {
  const text = "ping @org/team and @someone\n<img src=x onerror=y>\n[x](javascript:y) ![i](http://h/i.png)";
  const out = fence(text);
  const { open, body, close } = parts(out);
  assert.equal(open, BT.repeat(3));
  assert.equal(close, BT.repeat(3));
  assert.equal(body, text);
  // Nothing precedes the opening fence or follows the closing one.
  assert.ok(out.startsWith(`${BT.repeat(3)}\n`));
  assert.ok(out.endsWith(`\n${BT.repeat(3)}`));
});

test("a line of backticks inside cannot close the fence early", () => {
  const text = `a\n${BT.repeat(3)}\n@org/team\n${BT.repeat(3)}`;
  const out = fence(text);
  const { open } = parts(out);
  const lines = out.split("\n");
  // Only the first and last lines are a run of backticks at least as long as the fence.
  const closers = lines.filter((l) => /^`+$/.test(l.trim()) && l.trim().length >= open.length);
  assert.equal(closers.length, 2);
});

test("NUL and ESC are removed, CR is removed, tab and newline are kept", () => {
  const out = fence("a\u0000b\u001b[31mc\r\nd\te\u007f\u0085f");
  assert.equal(parts(out).body, "ab[31mc\nd\tef");
});

test("fence refuses a non-string", () => {
  assert.throws(() => fence(undefined), TypeError);
  assert.throws(() => fence({}), TypeError);
});

const PREFIXES = ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "sk-ant-", "x-access-token:"];

for (const prefix of PREFIXES) {
  test(`credentialLike detects ${prefix}`, () => {
    assert.equal(credentialLike(`value ${prefix}EXAMPLE end`), true);
    assert.equal(credentialLike(`${prefix}`), true);
  });
}

test("credentialLike detects x-access-token: in any case", () => {
  assert.equal(credentialLike("https://X-Access-Token:abc@example.invalid"), true);
  assert.equal(credentialLike("X-ACCESS-TOKEN:abc"), true);
});

test("credentialLike detects a private key header on one line", () => {
  const begin = "-----BEGIN";
  const tail = "PRIVATE KEY-----";
  assert.equal(credentialLike(`${begin} ${tail}`), true);
  assert.equal(credentialLike(`x\n${begin} RSA ${tail}\ny`), true);
  assert.equal(credentialLike(`${begin} OPENSSH ${tail}`), true);
});

test("credentialLike ignores BEGIN and PRIVATE KEY on different lines", () => {
  assert.equal(credentialLike("-----BEGIN CERTIFICATE-----\nPRIVATE KEY-----"), false);
  assert.equal(credentialLike("-----BEGIN PUBLIC KEY-----"), false);
});

test("credentialLike detects gh + U+200B + p_", () => {
  assert.equal(credentialLike("gh\u200bp_EXAMPLE"), true);
});

test("credentialLike detects each zero-width and format character inside a prefix", () => {
  for (const ch of ["\u200b", "\u200c", "\u200d", "\u2060", "\ufeff", "\u00ad"]) {
    assert.equal(credentialLike(`sk-${ch}ant-EXAMPLE`), true, `U+${ch.codePointAt(0).toString(16)}`);
  }
});

test("credentialLike detects fullwidth g, h, p followed by _ after NFKC", () => {
  assert.equal(credentialLike("\uff47\uff48\uff50_EXAMPLE"), true);
  assert.equal(credentialLike("\uff47\uff48\uff50\uff3fEXAMPLE"), true);
});

test("credentialLike detects a control character inside a prefix", () => {
  assert.equal(credentialLike("gh\u0000p_EXAMPLE"), true);
});

test("credentialLike is case-sensitive for the token prefixes", () => {
  assert.equal(credentialLike("GHP_x"), false);
  assert.equal(credentialLike("SK-ANT-x"), false);
  assert.equal(credentialLike("GITHUB_PAT_x"), false);
});

test("credentialLike passes ordinary review prose", () => {
  assert.equal(credentialLike("The ghost_ variable and graph_p are fine; see token handling."), false);
  assert.equal(credentialLike(""), false);
});

test("credentialLike refuses a non-string", () => {
  assert.throws(() => credentialLike(null), TypeError);
  assert.throws(() => credentialLike(42), TypeError);
});

test("anyCredential detects a credential in an object key", () => {
  assert.equal(anyCredential({ "ghp_EXAMPLE": "fine" }), true);
});

test("anyCredential detects a credential in a nested value", () => {
  assert.equal(anyCredential({ a: [1, true, null, { b: ["ok", "sk-ant-EXAMPLE"] }] }), true);
  assert.equal(anyCredential("github_pat_EXAMPLE"), true);
  assert.equal(anyCredential([{ deep: { "x-access-token:": 1 } }]), true);
});

test("anyCredential passes a clean value", () => {
  assert.equal(anyCredential({ verdict: "PASS", complete: true, unreviewed: [], summary: "ok", n: 3 }), false);
  assert.equal(anyCredential(null), false);
  assert.equal(anyCredential(7), false);
});

test("anyCredential scans an array too long to spread into arguments", () => {
  const wide = Array.from({ length: 300000 }, () => "clean");
  assert.equal(anyCredential(wide), false);
  wide[299999] = "ghr_EXAMPLE";
  assert.equal(anyCredential(wide), true);
});

test("anyCredential walks deeply nested input without exhausting the stack", () => {
  let value = "ghs_EXAMPLE";
  for (let i = 0; i < 200000; i += 1) value = [value];
  assert.equal(anyCredential(value), true);
  let clean = { k: "v" };
  for (let i = 0; i < 200000; i += 1) clean = { k: clean };
  assert.equal(anyCredential(clean), false);
});

test("truncate returns text within the limit unchanged", () => {
  assert.equal(truncate("a\nb", TRUNCATED.length), "a\nb");
  assert.equal(truncate("abc", 100), "abc");
});

test("truncate cuts at a line boundary and ends with the marker line", () => {
  const text = "line one\nline two\nline three\n";
  const out = truncate(text, 25);
  assert.equal(out, `line one\n${TRUNCATED}`);
  assert.equal(TRUNCATED, "[truncated]");
});

test("truncate never exceeds max", () => {
  const text = Array.from({ length: 50 }, (_, i) => `row ${i} ${"x".repeat(i % 17)}`).join("\n");
  for (let max = TRUNCATED.length; max <= text.length + 5; max += 1) {
    const out = truncate(text, max);
    assert.ok(out.length <= max, `max ${max} gave ${out.length}`);
    if (out !== text) {
      assert.ok(out.endsWith(TRUNCATED));
      const kept = out.slice(0, -TRUNCATED.length);
      assert.ok(kept === "" || kept.endsWith("\n"), `max ${max} cut mid-line`);
      assert.ok(text.startsWith(kept));
    }
  }
});

test("truncate keeps nothing but the marker when the first line is too long", () => {
  assert.equal(truncate("x".repeat(100), 20), TRUNCATED);
});

test("truncate refuses a max below the marker length or not an integer", () => {
  assert.throws(() => truncate("abc", TRUNCATED.length - 1), RangeError);
  assert.throws(() => truncate("abc", 1.5), RangeError);
  assert.throws(() => truncate("abc", Number.NaN), RangeError);
  assert.throws(() => truncate(5, 100), TypeError);
});
