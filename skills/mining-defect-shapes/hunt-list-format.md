# Hunt-list format

Every hunt list, shared or repo, is one Markdown file in this format. The
checker in the ship-kit repository (`tests/hunt-lists/format.mjs`) enforces
it for the shared lists; write repo lists the same way.

## Skeleton

1. A `# ` title on the first line.
2. A header paragraph saying who reads the list and naming this document
   (`skills/mining-defect-shapes/hunt-list-format.md`) as its format.
3. Optionally, `## METHOD`: one bullet per sentence of reviewing method.
   Reviewer-side mistakes found while mining become sentences here.
4. Exactly one `## Shapes` section holding the shapes, in increasing id
   order. A list with no shapes yet says so in one line under it.

## Shape block

Each shape is a heading followed by blank-line-separated paragraphs, in
this order:

1. `### <ID>. <Name> [generic]` or `### <ID>. <Name> [repo]`. The name is a
   noun phrase for the mechanism, not for the place it surfaced.
2. `Mechanism: ` one sentence saying how the defect comes about.
3. `Instances:` (repo lists only) on its own line, then one bullet per
   instance, each on a single line and labelled either
   `- Reached main: ` (the defect was merged) or `- Caught in review: `
   (a reviewer found it before merge). Describe each instance in the
   repository's own words.
4. `Look for: ` the tells a reviewer can check in a diff or a document.
5. `Not an instance: ` the look-alikes that are not this shape.

## Ids and owners

| Prefix | List | Owner |
|---|---|---|
| `D` | shared design shapes (`review/hunt-lists/design-shared.md`) | ship-kit |
| `S` | shared code shapes (`review/hunt-lists/code-shared.md`) | ship-kit |
| `RD` | repo design shapes | the adopting repository |
| `R` | repo code shapes | the adopting repository |

An id is permanent: tests, findings and other lists cite it. A shape keeps
its id and its name for life; a retired id stays unused, so the sequence may
have gaps. A new shape takes the next number after the highest id the list
has ever used.

## Tags

`[generic]` when the mechanism names nothing specific to one repository (no
product, service, path or team convention); otherwise `[repo]`. Shared
lists hold `[generic]` shapes only.

## Text

- ASCII characters only.
- No ticket numbers, PR numbers or review labels; say what happened in
  plain words.
- Shared lists carry mechanism, tells and exclusions only, with no
  `Instances:` paragraph and no text from any repository.

## Example

A repo code list with one shape:

<!-- example:begin -->
```markdown
# Repo code defect shapes

The adversarial seat reads this list with the shared code list. The format
is defined in skills/mining-defect-shapes/hunt-list-format.md.

## Shapes

### R1. Pagination loop that stops on a short page [generic]

Mechanism: A loop over a paginated API stops when a page holds fewer items than the page size, but the API may return short pages before the last one, so later items are silently dropped.

Instances:
- Reached main: the nightly export stopped after a page the API trimmed to 97 rows, so later accounts were missing from the file.
- Caught in review: the audit sync ended its loop on a short page instead of on an empty next-page cursor.

Look for: a loop condition comparing a page's length with the requested page size; no use of the next-page cursor or link header the API returns.

Not an instance: a loop that stops on an absent next-page cursor, or an API whose documentation guarantees full pages until the last.
```
<!-- example:end -->
