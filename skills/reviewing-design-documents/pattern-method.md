# Pattern method for stalled review rounds

Use this when review rounds on a design keep producing findings instead of converging.

1. **Classify findings by cause, not by section.** Build a pass index with one row per finding: round, section, cause class (for example a shape id from the design hunt list), and how it was fixed. Mark each class live (it has recurred, or its fix did not remove the cause) or closed.

2. **Find the root cause per live class.** Grep the fact's sites. When a fact lives at more than one site, reduce it to one site and replace the others with pointers to it.

3. **Focus the next review.** Read the whole document once with the list of live classes, and hunt each class everywhere, not only where it was found.

4. **Trace consequences before recommending a fix.** List every site the fix touches and every statement that depends on the changed one, and fix them in the same revision.

The method ends when no class is live. If a class stays live after one pass of this method, the mechanism is redesigned.
