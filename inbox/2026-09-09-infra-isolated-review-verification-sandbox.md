# Queue an isolated verification sandbox after read-only investigation

Michel approved expanding read-only MR investigation first, with a separate verification sandbox queued behind it (2026-09-09).

The current reviewer runs in a credential-bearing GitLab CI job. Image-owned tools can safely broaden source search, public documentation/dependency reads and published CI evidence, but enabling arbitrary shell/tests there would expose a larger filesystem and credential boundary.

Follow-up: design and implement a separate disposable verification environment with shell, writable scratch space, pinned dependency preparation and project tests. No GitLab/provider/production credentials or CI workspace mounts; controlled public egress and isolated test services. Keep posting in the parent runner. Preserve reviewed-head provenance, resource/time bounds, explicit execution evidence and untrusted-code handling. Decide how authenticated operational checks remain separately scoped; public docs cannot prove production configuration.

Acceptance should demonstrate actual test execution plus denied credential/internal-service access, not merely tool permission flags. This is queued work, not authorization to enable shell in the existing job.
