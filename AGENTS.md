PRD and ERD are in docs folder. 
Tasks are in tasks folder. Each task is it's own separate document (e.g. task-1.md, task-2.md, etc.).
Design reference is in design folder (read README.md in that folder).
All of the above documents are meant to be read by AI to provide context, so any modifications should be appropriate for that purpose.
Remember to commit regularly (probably after every task, but maybe multiple times per task if appropriate).

How to headlessly invoke other agents:

claude:
env -u CLAUDECODE claude -p "prompt"

Unset CLAUDECODE so the subprocess does not treat itself as a nested Claude Code session.

codex:
codex exec --skip-git-repo-check "prompt"

gemini:
agy -p "prompt"

<!-- INSFORGE:START -->
## InsForge backend

This project uses [InsForge](https://insforge.dev): an all-in-one, open-source Postgres-based backend (BaaS) that gives this app a database, authentication, file storage, edge functions, realtime, an AI model gateway, and payments through one platform.

- **Project:** **instrument** (API base `https://m5h8zr7r.us-east.insforge.app`)
- **Skills:** these InsForge skills are installed for supported coding agents. Reach for them before implementing any InsForge feature instead of guessing the API:
  - `insforge`: app code with the `@insforge/sdk` client (database CRUD, auth, storage, edge functions, realtime, AI, email, and Stripe payments).
  - `insforge-cli`: backend and infrastructure via the `insforge` CLI (projects, SQL, migrations, RLS policies, storage buckets, functions, secrets, payment setup, schedules, deploys).
  - `insforge-debug`: diagnosing failures (SDK/HTTP errors, RLS denials, auth and OAuth issues) and running security or performance audits.
  - `insforge-integrations`: wiring external auth providers (Clerk, Auth0, WorkOS, Better Auth, etc.) for JWT-based RLS, or the OKX x402 payment facilitator.
  - `find-skills`: discovering additional skills on demand.
- **Credentials:** app code reads keys from `.env.local`; the CLI reads `.insforge/project.json`. Never hardcode or commit keys.

Key patterns:

- Database inserts take an array: `insert([{ ... }])`.
- Reference users with `auth.users(id)`; use `auth.uid()` in RLS policies.
- For storage uploads, persist both the returned `url` and `key`.
<!-- INSFORGE:END -->
