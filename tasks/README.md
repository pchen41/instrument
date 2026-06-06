Tasks should be reasonable-sized self-contained units of work that make incremental progress toward the final result and are testable both in an automated and manual way. Remember to write tests when implementing them.
Task files contain requirements, acceptance criteria and are modified to include any progress or notes so that future agents can take over.
When working on tasks, remember to commit regularly (probably after every task, but maybe multiple times per task if appropriate).

## Task Index

- `task-0.md` - Verify first-slice provisioning and external integration readiness.
- `task-1.md` - Scaffold the app, auth entry, and console shell.
- `task-2.md` - Add the core InsForge schema, RLS, and seed data.
- `task-3.md` - Seed first-slice workflow records and schema validation helpers.
- `task-4.md` - Build server-backed console reads, polling, and persisted UI state.
- `task-5a.md` - Implement durable jobs, leases, retries, and server mutation endpoints.
- `task-5b.md` - Prove worker runtime viability for Edge Functions versus Compute.
- `task-5c.md` - Implement the TrueFoundry AI Gateway and MCP foundation.
- `task-5d.md` - Implement Datadog instrumentation, reliability telemetry, and integration health.
- `task-6.md` - Implement GitHub webhook ingestion and automatic PR observability review comments.
- `task-7.md` - Implement primary-branch scans and recommendation lifecycle management.
- `task-8.md` - Implement approved recommendation PR generation.
- `task-9.md` - Implement Datadog monitor analysis and approved draft alert creation.
- `task-10.md` - Implement Datadog alert ingestion and incident lifecycle.
- `task-11.md` - Implement incident investigation with evidence-backed AI output.
- `task-12.md` - Implement the TrueFoundry reliability validation path.

Recommended sequence: Task 0 first for external readiness, then Tasks 1-3.
Task 4 can build against seeded data while Tasks 5A-5D establish the worker,
runtime decision, AI/MCP foundation, telemetry, and integration health. Task 5B
is a decision gate: if representative TrueFoundry Agent/MCP work does not fit
scheduled Edge Function ticks, promote InsForge Compute into the first-slice
worker runtime before implementing downstream provider workflows. Tasks 6, 7, 9,
and 11 should consume the MCP foundation from Task 5C rather than introducing
direct provider access patterns that need later replacement.

Broad Datadog instrumentation is cross-cutting. Task 1 owns the optional
frontend RUM wrapper and browser-safe config shape. Task 5D owns shared
server-side logs/metrics/traces utilities. Every later task that adds server
functions, workers, provider calls, model/MCP calls, read endpoints, or external
writes should use those utilities as it builds the feature.
