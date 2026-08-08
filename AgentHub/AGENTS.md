# Agent Hub repository guidance

## Testing

- Do not add or extend tests that read production source files and assert literal
  implementation text, formatting, CSS declarations, or regular-expression
  snapshots. Existing source-text assertions are legacy coverage, not a pattern
  for new tests.
- Test observable behavior through pure unit tests, public contracts, DOM-level
  tests, or integration/end-to-end tests. Extract a focused testable unit when
  behavior is otherwise trapped inside a large client file.
- A source-text assertion is allowed only for a static packaging or build
  invariant that cannot be exercised through an executable contract. Keep that
  exception narrow and document why a behavioral test is unavailable.
- If the current test harness cannot cover a UI change behaviorally, report the
  coverage gap instead of adding an implementation snapshot.
