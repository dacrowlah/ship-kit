# Shared code defect shapes

The adversarial seat reads this list together with the repository's own code
list on every review. The METHOD below applies to every finding the seat
reports. The format is defined in
skills/mining-defect-shapes/hunt-list-format.md. Shapes enter this list only
by promotion: a [generic] shape mined independently in two or more adopting
repositories, written as mechanism, tells and exclusions with no instance
text. Ids are permanent: a shape is never renumbered or re-titled, and a
retired id is never reused.

## METHOD

- Verify every finding against the repository before reporting it: read the code, the test or the configuration the finding is about.
- Hold your own claims about a dependency to the version the repository pins, and say UNVERIFIED when that version cannot be checked.
- Treat a justification comment as a condition to check, not a settlement: confirm that what it says is true of the code beside it.
- Report a defect under the closest shape with a note on how it differs, rather than withhold it because no shape fits exactly.
- Report each defect once, with a concrete failure scenario: the input or state, what happens, and what should have happened.
- Say plainly when nothing is found.

## Shapes

None yet. Shapes enter this list only by promotion from adopting repositories' lists.
