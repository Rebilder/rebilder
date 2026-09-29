# 043-body-over-cap-truncated

A response reaches the byte cap and is truncated. The expected result identifies incomplete evidence rather than grading a partial body as a full page.

Current expected result: **unscored / truncated-evidence**. The adjacent `expected.json` contains the complete scoring projection, flags and per-check values; the conformance runner verifies them against the captured evidence. Fixture scores are test results, not customer outcomes.
