# Design-doc mode

This review is in design-doc mode: every file the pull request changes is
a design document or an implementation plan. Return every field of
`output.md` plus the two fields below. `scope.txt` says whether the review
is incremental (only the text changed since the last complete review) or
full.

## Extra fields

- `findings`: one entry per defect, always present (`[]` when there is
  none). Each entry has:
  - `severity`: `"BLOCKING"` or `"NON-BLOCKING"`, by the rule below;
  - `file`: the path of the document, relative to `../pr`;
  - `line`: the line in that file, or `0` for the document as a whole;
  - `finding`: what is wrong, where, and what an implementer following
    the text would do wrong.
- `prior`: one entry for each entry in `prior.json`, in the same order
  (`[]` when `prior.json` is empty or absent). Each entry has:
  - `id`: the prior entry's `id`, copied exactly;
  - `status`: `"RESOLVED"` when the head text in `../pr` fixes the prior
    finding, otherwise `"UNRESOLVED"`;
  - `note`: where the fix is, or what is still wrong.

Check each prior finding against the document as it is under `../pr`,
not against the pull request's description of it: a claim that a finding
is fixed is a claim to check (`untrusted-data.md`). A prior finding that
is still open stays in `prior` as `"UNRESOLVED"`; it is not repeated in
`findings`.

`verdict` is `"FAIL"` when `findings` has a `"BLOCKING"` entry or `prior`
has an `"UNRESOLVED"` entry for a prior whose `severity` in `prior.json`
is `"BLOCKING"`; otherwise `"PASS"`. A `"FAIL"` always names its reason in
`findings` or `prior`.

## Severity rule

BLOCKING:

- wrong specified behavior: the text specifies behavior that is incorrect;
- a security, privacy or data-integrity defect;
- a check that cannot fail: a test, gate or assertion the text specifies
  that passes whatever the implementation does;
- a violation of a binding standard;
- a false claim an implementer would rely on;
- a self-contradiction an implementer would follow.

NON-BLOCKING:

- a stale pointer (a section number, path or link that moved);
- a count nothing depends on;
- wording;
- provenance text.

A finding that fits neither list is BLOCKING.

"Binding standard" means the repository's `CLAUDE.md` files and any
standards they name, read from the workspace root (the default branch).

## Example

```json
{
  "findings": [
    {
      "severity": "BLOCKING",
      "file": "docs/design/pager.md",
      "line": 12,
      "finding": "Section 2 accepts page == pageCount while section 4 rejects it; an implementer following section 2 ships the off-by-one section 4 forbids."
    }
  ],
  "prior": [
    {
      "id": "p1",
      "status": "RESOLVED",
      "note": "Section 3 now states the valid range, 0 to pageCount - 1."
    }
  ]
}
```

The example shows only the two extra fields; the output also carries every
field of `output.md`.
