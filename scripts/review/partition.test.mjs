import assert from "node:assert/strict";
import test from "node:test";
import {
  partition, fullScope, planDesignDocScope, assignPriors, needsPriorCheck,
} from "./partition.mjs";

const OPTS = { maxSeats: 4, targetLines: 400 };

function file(path, weight) {
  return { path, weight };
}

// Deterministic PRNG (mulberry32) so the property test is reproducible.
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function everyFileOnce(files, bins) {
  const flat = bins.flat();
  assert.equal(flat.length, files.length);
  assert.deepEqual(new Set(flat.map((f) => f.path)), new Set(files.map((f) => f.path)));
}

// --- partition ---

test("partition: zero files is zero seats", () => {
  assert.deepEqual(partition([], OPTS), []);
});

test("partition: one file is one seat holding it", () => {
  const files = [file("a.mjs", 10)];
  const bins = partition(files, OPTS);
  assert.deepEqual(bins, [[file("a.mjs", 10)]]);
});

test("partition: maxSeats 1 puts everything in one seat", () => {
  const files = [file("a.mjs", 900), file("b.mjs", 900), file("c.mjs", 900)];
  const bins = partition(files, { maxSeats: 1, targetLines: 400 });
  assert.equal(bins.length, 1);
  everyFileOnce(files, bins);
});

test("partition: all weights zero never exceeds one seat (byLines is zero)", () => {
  const files = Array.from({ length: 20 }, (_, i) => file(`f${i}.mjs`, 0));
  const bins = partition(files, OPTS);
  assert.equal(bins.length, 1);
  everyFileOnce(files, bins);
});

test("partition: no seat is empty and no file is dropped or duplicated (1000 random files, seeded)", () => {
  const rand = seededRandom(20260928);
  const files = Array.from({ length: 1000 }, (_, i) => file(`f${i}.mjs`, Math.floor(rand() * 500)));
  const bins = partition(files, { maxSeats: 12, targetLines: 300 });
  everyFileOnce(files, bins);
  for (const bin of bins) {
    assert.notEqual(bin.length, 0);
  }
});

test("partition: no seat is empty even when only one file carries all the weight", () => {
  // Adversarial: byLines is driven by one heavy file, but the rest weigh
  // zero. A naive tie-break (always the lowest index on equal totals)
  // would pile every zero-weight file onto a single seat.
  const files = [
    file("heavy.mjs", 1200),
    ...Array.from({ length: 11 }, (_, i) => file(`z${i}.mjs`, 0)),
  ];
  const bins = partition(files, { maxSeats: 12, targetLines: 300 });
  assert.equal(bins.length, 4); // ceil(1200/300) = 4, capped by neither maxSeats nor files.length
  everyFileOnce(files, bins);
  for (const bin of bins) {
    assert.notEqual(bin.length, 0);
  }
});

test("partition: seat count is capped at the file count even with a huge weight and maxSeats", () => {
  const files = [file("a.mjs", 100000)];
  const bins = partition(files, { maxSeats: 50, targetLines: 1 });
  assert.equal(bins.length, 1);
});

test("partition: longest file lands with the earliest-assigned (lightest) seat first", () => {
  const files = [file("a.mjs", 500), file("b.mjs", 400), file("c.mjs", 300), file("d.mjs", 200)];
  const bins = partition(files, { maxSeats: 4, targetLines: 100 });
  assert.equal(bins.length, 4);
  assert.deepEqual(bins[0], [file("a.mjs", 500)]);
  assert.deepEqual(bins[1], [file("b.mjs", 400)]);
});

test("partition: rejects a non-array files argument", () => {
  assert.throws(() => partition(null, OPTS), TypeError);
});

// --- planDesignDocScope / fullScope ---

const HEAD = "1".repeat(40);
const STATE_HEAD = "2".repeat(40);
const MERGE_BASE = "3".repeat(40);
const STATE_MERGE_BASE = "4".repeat(40);

function deps(overrides = {}) {
  return {
    prFiles: ["docs/design/a.md", "docs/design/b.md"],
    state: {
      mode: "design-doc",
      head: STATE_HEAD,
      mergeBase: STATE_MERGE_BASE,
      findings: [{ severity: "BLOCKING", file: "docs/design/a.md", line: 1, finding: "x" }],
    },
    head: HEAD,
    mergeBase: MERGE_BASE,
    isAncestor: () => true,
    changedFiles: () => [],
    ...overrides,
  };
}

test("fullScope: carries the reason, no restriction, no priors", () => {
  assert.deepEqual(fullScope("some reason"), {
    incremental: false, since: null, files: null, priors: [], reason: "some reason",
  });
});

test("planDesignDocScope: no prior state is a full scope", () => {
  const result = planDesignDocScope(deps({ state: null }));
  assert.equal(result.incremental, false);
  assert.equal(result.priors.length, 0);
});

test("planDesignDocScope: a full-mode prior state is a full scope", () => {
  const result = planDesignDocScope(deps({ state: { ...deps().state, mode: "full" } }));
  assert.equal(result.incremental, false);
});

test("planDesignDocScope: a bad merge base (not 40 hex) is a full scope", () => {
  const result = planDesignDocScope(deps({ mergeBase: "not-a-sha" }));
  assert.equal(result.incremental, false);
  const result2 = planDesignDocScope(
    deps({ state: { ...deps().state, mergeBase: "short" } }),
  );
  assert.equal(result2.incremental, false);
});

test("planDesignDocScope: the state head not an ancestor of head is a full scope", () => {
  const result = planDesignDocScope(deps({ isAncestor: () => false }));
  assert.equal(result.incremental, false);
});

test("planDesignDocScope: isAncestor throwing is a full scope", () => {
  const result = planDesignDocScope(deps({
    isAncestor: () => { throw new Error("git blew up"); },
  }));
  assert.equal(result.incremental, false);
});

test("planDesignDocScope: the base moved under a PR file is a full scope", () => {
  const result = planDesignDocScope(deps({
    changedFiles: (from) => (from === STATE_MERGE_BASE ? ["docs/design/a.md"] : []),
  }));
  assert.equal(result.incremental, false);
  assert.match(result.reason, /base/);
});

test("planDesignDocScope: files a merge from base touched (outside the PR's own files) are excluded", () => {
  const result = planDesignDocScope(deps({
    changedFiles: (from) => {
      if (from === STATE_MERGE_BASE) return []; // base did not move under a PR file
      // since..head also carries an unrelated file pulled in by merging base
      return ["docs/design/a.md", "README.md"];
    },
  }));
  assert.equal(result.incremental, true);
  assert.deepEqual(result.files, ["docs/design/a.md"]);
});

test("planDesignDocScope: a throwing changedFiles is a full scope", () => {
  const result = planDesignDocScope(deps({
    changedFiles: () => { throw new Error("git blew up"); },
  }));
  assert.equal(result.incremental, false);
});

test("planDesignDocScope: a non-array changedFiles result is a full scope", () => {
  const result = planDesignDocScope(deps({ changedFiles: () => "not-an-array" }));
  assert.equal(result.incremental, false);
});

test("planDesignDocScope: a throwing changedFiles for the since..head range is a full scope", () => {
  const result = planDesignDocScope(deps({
    changedFiles: (from) => {
      if (from === STATE_MERGE_BASE) return [];
      throw new Error("git blew up");
    },
  }));
  assert.equal(result.incremental, false);
});

test("planDesignDocScope: a non-array changedFiles result for the since..head range is a full scope", () => {
  const result = planDesignDocScope(deps({
    changedFiles: (from) => (from === STATE_MERGE_BASE ? [] : "not-an-array"),
  }));
  assert.equal(result.incremental, false);
});

test("planDesignDocScope: the qualifying case is incremental, since the state head, carrying its findings", () => {
  const result = planDesignDocScope(deps());
  assert.equal(result.incremental, true);
  assert.equal(result.since, STATE_HEAD);
  assert.equal(result.reason, null);
  assert.equal(result.priors.length, 1);
});

// --- assignPriors ---

test("assignPriors: a finding whose file sits in a seat is assigned that seat", () => {
  const bins = [[file("a.mjs", 10)], [file("b.mjs", 5)]];
  const priors = [{ severity: "BLOCKING", file: "b.mjs", line: 3, finding: "x" }];
  const result = assignPriors(priors, bins);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "p1");
  assert.equal(result[0].seat, 1);
  assert.equal(result[0].file, "b.mjs");
  assert.equal(result[0].severity, "BLOCKING");
});

test("assignPriors: a finding whose file is in no seat goes to the lightest seat", () => {
  const bins = [[file("a.mjs", 100)], [file("b.mjs", 5)]];
  const priors = [{ severity: "BLOCKING", file: "nowhere.mjs", line: 1, finding: "x" }];
  const result = assignPriors(priors, bins);
  assert.equal(result[0].seat, 1);
});

test("assignPriors: no seats yields seat null", () => {
  const priors = [{ severity: "BLOCKING", file: "a.mjs", line: 1, finding: "x" }];
  const result = assignPriors(priors, []);
  assert.equal(result[0].seat, null);
});

test("assignPriors: normalizes a malformed finding rather than propagating it", () => {
  const result = assignPriors([{ file: 42 }], [[file("a.mjs", 1)]]);
  assert.equal(result[0].severity, "BLOCKING");
  assert.equal(result[0].file, "");
  assert.equal(result[0].line, 0);
});

// --- needsPriorCheck ---

test("needsPriorCheck: no paths and a BLOCKING prior is true", () => {
  assert.equal(
    needsPriorCheck([], [{ severity: "BLOCKING" }]),
    true,
  );
});

test("needsPriorCheck: no paths but only NON-BLOCKING priors is false", () => {
  assert.equal(
    needsPriorCheck([], [{ severity: "NON-BLOCKING" }, { severity: "NON-BLOCKING" }]),
    false,
  );
});

test("needsPriorCheck: paths present is false even with a BLOCKING prior", () => {
  assert.equal(
    needsPriorCheck(["a.mjs"], [{ severity: "BLOCKING" }]),
    false,
  );
});

test("needsPriorCheck: no paths and no priors is false", () => {
  assert.equal(needsPriorCheck([], []), false);
});
