# 024-robots-persistent-500

Persistent robots.txt server failure produces an unscored result. The probe controls retries; the scorer evaluates the recorded evidence.

Current expected result: **unscored / robots-unavailable**. The adjacent `expected.json` contains the complete scoring projection, flags and per-check values; the conformance runner verifies them against the captured evidence. Fixture scores are test results, not customer outcomes.
