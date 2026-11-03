# OBS token repair lock budget — item 77 follow-up

Main commit `2dea9489fd04ad231a3a9a3e09ad5c0e25acb7ef` failed its Windows core check because a nominal 15-second lock timeout became `15.000000000000057` through floating-point addition/subtraction. That main delivery remains a failed observation; the earlier PR head/local validation is separate evidence.

The lock timeout now clamps the remaining deadline budget to the closed range 0–15 seconds. It still subtracts the current monotonic clock from the original deadline, retains all owner/deadline checkpoints and leaves failed lock acquisition retryable without OBS writes.

A deterministic regression uses the clock value `1.1`, for which `(1.1 + 15) - 1.1` exceeds 15. It checks the actual lock argument against the literal ceiling, no release or writes after failed acquisition, then actual cached-mapping retry, revalidation and the nine expected disposable OBS updates. Existing ownership, expiry, retry and strict timeout assertions remain unchanged.

The author performed only pure arithmetic selection, Python AST parsing and whitespace inspection. Tests, native/API/OBS operations and agent launch were not executed by the author. Independent review/refutation and coordinator exact-head validation/CI/delivery are required. This follow-up does not establish a signed native release or installed-agent acceptance, and item 77 remains partial.
