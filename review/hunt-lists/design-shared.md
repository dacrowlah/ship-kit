# Design-document defect shapes

The generic ways design documents and implementation plans go wrong. Design
reviewers hunt every shape on every round, and the adversarial seat hunts
them in design-doc mode. Ids are permanent: other lists, tests and review
findings cite them, so a shape is never renumbered or re-titled, and a
retired id is never reused. The format is defined in
skills/mining-defect-shapes/hunt-list-format.md.

## Shapes

### D1. Prose-specified executable [generic]

Mechanism: A function, script or configuration is given as numbered prose steps while its siblings are code, so the design's own verification cannot reach it.

Look for: "the steps are the specification"; an algorithm, parser or configuration described only in numbered steps beside siblings that have a code block; a behaviour the plan says to "implement as described" with no text a reader could run, parse or diff.

Not an instance: a procedure a human carries out once (an owner approving a ruleset, a release checklist) written as steps, where nothing is transcribed into code.

### D2. Derived number without its model [generic]

Mechanism: A count, threshold or bound is computed offline and printed without the model that produced it, so the next reader re-derives it under another convention.

Look for: "at least N", "about N ms", "up to N pages", a coverage floor or a timeout with no formula, measurement or source beside it; two sites that print the same quantity with different values because each re-derived it.

Not an instance: a carried value chosen by fiat and labelled as such (a default the owner picked, a vendor limit quoted with its citation), from which nothing else is derived.

### D3. Twin left behind [generic]

Mechanism: One fact lives at several sites and a fix edited only one.

Look for: grep the fact's token (a name, a path, a number, a check context) and compare the value at every site; a review fix whose diff touches one section while the same fact also appears in a table, a summary or a task.

Not an instance: a second site that points at the canonical one ("see 6.5") without restating the value.

### D4. Summary contradicts detail [generic]

Mechanism: A summary, status line or ruling paraphrase states a rule that the mechanism section qualifies.

Look for: compare every summary sentence with the formula or mechanism it summarizes; an "always", "never" or "every" in an overview where the mechanism section has an exception, a precondition or a fallback.

Not an instance: a summary that is explicitly marked as a brief and defers to the canonical section for the exact rule.

### D5. Enumeration at fewer sites [generic]

Mechanism: A union, list, census or family gains a member at some of its sites but not all (type, tests, summary, table).

Look for: count the members at every site that enumerates the family (a type union, a test table, an inventory, a summary sentence, a config default) and compare the counts and names.

Not an instance: a site that deliberately names a subset and says which subset it is ("the two seats that read hunt lists").

### D6. Vendor page, wrong version [generic]

Mechanism: A toolchain claim is checked against the vendor's current documentation instead of the pinned artifact actually in use.

Look for: a version-pinned dependency cited to an unversioned docs page or a README on a moving branch; open the installed source or the tagged release and check the claim there.

Not an instance: a claim about a dependency the design does not pin, cited to the current docs and marked as re-checked before each release.

### D7. Check that cannot fail for its claim [generic]

Mechanism: A probe cited as evidence tests a neighboring property, so it would have passed had the claim been false.

Look for: ask what the probe would have printed if the claim were false; a test that asserts a file exists when the claim is about its content; a grep that matches a comment rather than the code path; a check whose only input is a value the author chose.

Not an instance: a check that is weak but aimed at the claimed property and would go red if that property broke.

### D8. Repository fact assumed [generic]

Mechanism: A claim about the repository (CI, deploy routes, roles, scripts) is made with no file and line.

Look for: a statement about how the repository behaves (which job deploys, which role can read a table, which script a hook runs) with no path cited; read the file and check the claim against it.

Not an instance: a statement about what the design will add, which has no file yet and is specified in the design itself.

### D9. Stale provenance [generic]

Mechanism: A provenance claim ("run verbatim", "byte for byte", "the earlier version did X") was made false by a later edit.

Look for: diff the claim against the commit or text it describes; "was run", "parses", "verified" beside a block that a later round edited.

Not an instance: a provenance claim re-established after the last edit, with the run or parse repeated against the current text.

### D10. Test stated three times [generic]

Mechanism: One test is stated in several places (narrative, task, audit row) that must move together and did not.

Look for: pick one statement of the test (its name, its fixture, its expected output) and check every other statement of it against that one; a test named in a mechanism section, a task and a verification table.

Not an instance: one site that specifies the test and others that only point at it by name.

### D11. Mutation that cannot redden [generic]

Mechanism: A named mutation's fixture values make the assertion pass either way, so the mutation cannot turn it red.

Look for: apply the mutation to the fixture arithmetic by hand or by running it; a boundary mutation whose fixtures sit far from the boundary; a mutation of a branch the fixtures never reach.

Not an instance: a mutation whose red run was observed and is quoted with its output.

### D12. Interface frozen against its dependency [generic]

Mechanism: A specified signature (synchronous, a type) cannot be implemented with the helper the design names for it.

Look for: read the helper's actual signature; a synchronous function specified over an asynchronous API; a return type the named library does not produce; an argument the dependency does not accept.

Not an instance: an interface that names its own adapter as the place where the mismatch is bridged, and specifies that adapter.

### D13. Rulings by accretion [generic]

Mechanism: A ruling paragraph accumulates clarifications and consequences, and a mechanism change leaves a stale consequence in it.

Look for: compare every consequence stated in a ruling with the mechanism section that implements it; a ruling that has grown past a quote and a pointer.

Not an instance: a ruling that is the owner's words, a pointer to the implementing section and the test that pins it, with no consequences restated.

### D14. Fix-round residue [generic]

Mechanism: A review fix addresses the reviewer's example rather than the rule, re-derives under a new model, or adds a restatement.

Look for: re-verify the previous round's fixes before anything else; a fix that edits exactly the quoted sentence while the same defect sits one paragraph away; a fix that adds "note:" or "to be clear" text restating a mechanism.

Not an instance: a fix that corrects the rule at its one canonical site and removes the restatement that caused the finding.

### D15. Unreported stall [generic]

Mechanism: A path on which work is held back is neither reported, deferred with a cause, nor faulted.

Look for: "left as it was", "skipped", "no action" with no "reported"; a loop or retry whose exhaustion path says nothing to the user; an empty input that silently produces an empty result.

Not an instance: a held-back path that ends in a report naming the cause, or in a failure.

### D16. Time-order dependence [generic]

Mechanism: A result depends on when a job looked or the order events arrived, or stored derived state is invalidated by a later fact.

Look for: stored conclusions instead of recomputed ones; "the latest comment", "the last run", "when the job starts" as an input; a cached verdict that a later push, label or edit does not invalidate.

Not an instance: stored state keyed to an immutable identifier (a commit SHA) and recomputed whenever that identifier changes.

### D17. Guard that admits a state [generic]

Mechanism: A guard or recovery clause is tested only on the states its author imagined and admits one it should refuse.

Look for: enumerate the states the guard's predicate does not distinguish (absent, empty, malformed, cancelled, skipped, unknown) and check which way each falls; a default branch that allows.

Not an instance: a guard whose predicate refuses every state it does not explicitly admit, with tests on the refused states.

### D18. Declared cost that is not [generic]

Mechanism: A cost is declared ("cheap", a per-call figure, a budget) from a path whose placement or pinning differs.

Look for: check the cost model's preconditions (region, cache, connection reuse, batch size) against the path at hand; a figure measured on one path quoted for another.

Not an instance: a relative cost statement ("doubles review for the window") that holds whatever the absolute figures are.

### D19. Standard departed silently [generic]

Mechanism: A choice contradicts a binding standard without the amendment the standard requires, or with a false reason.

Look for: read the standard's clause the choice touches; a departure with no amendment in the same change; a reason that the standard's own text contradicts.

Not an instance: a departure that amends the standard in the same change and states a reason that holds.

### D20. History in the specification [generic]

Mechanism: Version narrative sits inside normative sections, each sentence a stale-provenance defect waiting to happen.

Look for: "previously", "now", "was changed to", "no longer", "originally" in a mechanism section; a changelog or revision table inside the design.

Not an instance: a statement of the current design that mentions a rejected alternative only to say why it is not used.
