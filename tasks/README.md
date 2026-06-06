Tasks should be reasonable-sized self-contained units of work that make incremental progress toward the final result and are testable both in an automated and manual way. Remember to write tests when implementing them.
Task files contain requirements, acceptance criteria and are modified to include any progress or notes so that future agents can take over.
When working on tasks, remember to commit regularly (probably after every task, but maybe multiple times per task if appropriate).

## Task Index

- `task-1.md` - Scaffold the app, auth entry, and console shell.
- `task-2.md` - Add the core InsForge schema, RLS, and seed data.
- `task-3.md` - Seed first-slice workflow records and schema validation helpers.
- `task-4.md` - Build server-backed console reads, polling, and persisted UI state.
- `task-5.md` - Implement durable jobs, worker runtime, MCP foundation, retries, failure states, and telemetry.
- `task-6.md` - Implement GitHub webhook ingestion and automatic PR observability review comments.
- `task-7.md` - Implement primary-branch scans and recommendation lifecycle management.
- `task-8.md` - Implement approved recommendation PR generation.
- `task-9.md` - Implement Datadog monitor analysis and approved draft alert creation.
- `task-10.md` - Implement Datadog alert ingestion and incident lifecycle.
- `task-11.md` - Implement incident investigation with evidence-backed AI output.
- `task-12.md` - Implement the TrueFoundry reliability validation path.

Recommended sequence: Tasks 1-3 first, then Task 4 can build against seeded
data while Task 5 establishes the worker/MCP foundation. Tasks 6, 7, 9, and 11
should consume the MCP foundation from Task 5 rather than introducing direct
provider access patterns that need later replacement.
