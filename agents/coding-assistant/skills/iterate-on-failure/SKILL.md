---
name: iterate-on-failure
description: Run a command, diagnose the failure, patch, and re-run.
---

# Iterate on failure

1. Run the smallest command that should pass (test, lint, or script).
2. Capture the error verbatim in your reasoning.
3. Form one hypothesis; apply a minimal fix.
4. Re-run the same command.
5. Stop after 3 failed iterations and ask the user for guidance — do not thrash.
