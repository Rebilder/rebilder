# 064-linked-markdown-copy

The 002 product page with one change: its HTML links to a Markdown copy at a separate address, and that copy loads. The agent probe still receives HTML, so the page does not negotiate. This pins the ARS 0.3 partial credit for a working linked copy, the parity comparison against it, and Vary staying at zero.

Current expected result: **C (71)**. The adjacent `expected.json` contains the complete scoring projection, flags and per-check values; the conformance runner verifies them against the captured evidence. Fixture scores are test results, not customer outcomes.
