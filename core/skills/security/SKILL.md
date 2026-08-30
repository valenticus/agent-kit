---
name: security
description: Design, change, debug, or review authorization, ownership, tenant visibility, privileged functions, sensitive mutations, atomicity, idempotency, and data-integrity boundaries.
---

# Security

Read the project-security and project-data hooks before changing authority or integrity behavior.

- Trace the authenticated principal through every policy, service/RPC boundary, and affected row; UI filtering is not security.
- Treat client identifiers and values as untrusted. Derive identity server-side and validate ownership, membership/tenant context, state, and references at the enforcing boundary.
- Keep multi-record sensitive mutations atomic and retry-safe where required.
- Preserve append-only history and migration rules defined by the project.
- Test representative allowed, unauthenticated, unauthorized, cross-tenant, invalid-reference, retry, and concurrency paths as applicable.
- Review privileges, policy coverage, privileged execution context, information leakage, and rollback/compatibility.

Stop when the project's authority model is missing or ambiguous enough to change access behavior.
