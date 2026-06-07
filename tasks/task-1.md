# Task 1: Scaffold app, auth entry, and console shell

## Status

Not started (scaffold). Pre-flight readiness verified 2026-06-06 — see Progress Notes.

## Context

Read `docs/PRD.md`, `docs/ERD.md`, and `design/README.md` before starting. The repository currently contains planning docs, design prototypes, and InsForge project linkage, but no production app scaffold.

The design reference is under `design/project/`. The primary console prototype is `design/project/Console.html`, which loads `console/data.jsx`, `console/ui.jsx`, `console/shell.jsx`, `console/incidents.jsx`, `console/views.jsx`, and `console/app.jsx`. The auth prototype is visual reference only for the demo; the PRD limits auth to username/password login for one configured workspace.

## Requirements

- Create the production frontend scaffold using the stack named in the ERD: Vite, React, TypeScript, Tailwind CSS 3.4, `@insforge/sdk`, and Phosphor icons via `@phosphor-icons/react`.
- Add basic routing for sign-in and the console views: Incidents, Recommendations, and Integrations.
- Import or recreate the design assets from `design/project/assets/`, including the Instrument logo, color tokens, typography, and icon choices. The prototype's inline SVG icon layer is a portability detail of the exported design; the production app should use Phosphor React icons while matching the prototype's weight and sizing.
- It is acceptable for the first production scaffold to import/adapt the prototype's CSS token files and component CSS directly while Tailwind is present in the stack. Do not spend this task mechanically rewriting every prototype rule into Tailwind utilities unless it makes the implementation simpler.
- Implement a sign-in-only demo auth flow backed by InsForge auth. Do not expose admin keys in frontend env vars.
- Build the console shell with sidebar navigation, connected-source list, profile area, and empty server-backed page containers.
- Keep the incident-fix PR action from the prototype out of the demo UI, or leave it disabled with clear internal code comments, because PRD/ERD mark it future scope.
- Add environment examples for browser-safe InsForge values and optional
  browser-safe Datadog RUM values only. Do not expose Datadog API keys, app keys,
  InsForge admin keys, or provider secrets in frontend env vars.
- Add a small frontend telemetry wrapper that initializes Datadog RUM/error
  tracking only when browser-safe Datadog RUM config is present. It should record
  route changes, console load failures, failed user actions, and API/read
  failures as later views are built, while becoming a no-op when config is
  absent.

## Acceptance Criteria

- A developer can install dependencies, run the app locally, and see the sign-in page and console shell.
- Unauthenticated users are directed to sign in; authenticated users can reach the console.
- The console shell matches the visual direction of the prototype: warm paper background, Instrument branding, calm state palette, sidebar navigation, and dense operational layout.
- The three console sections exist as routable views, even if they initially render empty states.
- No signup or OAuth setup flow is required for the demo unless the PRD changes.
- No incident "Generate fix" workflow is available as an active demo action.
- The frontend runs with Datadog RUM config absent, and uses the telemetry
  wrapper when browser-safe RUM config is present.

## Automated Tests

- Add unit tests for auth route guards and sign-in form validation.
- Add a smoke/component test that renders the console shell and verifies the three navigation items.
- Add a test that the frontend telemetry wrapper is a no-op without RUM config
  and initializes with browser-safe RUM config.
- Add a build check in the task notes once it passes.

## Manual Verification

- Run the dev server.
- Sign in with the configured demo user.
- Confirm refresh preserves the authenticated console route.
- Confirm sign-out returns to the auth entry.

## Progress Notes

- Update this section with commands run, test results, and any deviations from the design prototype.

### 2026-06-06 — Pre-flight readiness check (scaffold not yet started)

Assessment: Task 1 is ready to implement. It is greenfield frontend scaffolding and
does **not** depend on Task 2/3 — the three console sections render empty states for
now. No production app scaffold exists yet (no root `package.json`).

Verified ready:
- **InsForge project linked & reachable**: `instrument`
  (id `016142f5-59b5-40a1-a86d-d40e7c2d482f`), app key `m5h8zr7r`, region `us-east`,
  base URL `https://m5h8zr7r.us-east.insforge.app`. Checked with
  `npx @insforge/cli current` / `metadata`.
- **Design assets present**: `design/project/` — console prototype (`console/*.jsx`,
  `console/app.css`), auth prototype (`auth.jsx`, `auth.css`), tokens
  (`assets/colors_and_type.css`), logos/SVGs under `assets/`, Phosphor-style icon
  reference in `assets/icons.js`. Production app should use `@phosphor-icons/react`.
- **Stack to use** (per ERD): Vite + React + TypeScript + Tailwind CSS 3.4 +
  `@insforge/sdk` + `@phosphor-icons/react`.
- **`.env.*` is gitignored** (`.gitignore` covers `.env` / `.env.*`, keeps
  `.env.example`).

Config change applied:
- **Email verification turned OFF.** Was `require_email_verification = true` with SMTP
  disabled (which would strand normally-signed-up users). Flipped to `false` via
  `insforge.toml` + `npx @insforge/cli config apply` (no skips; confirmed via
  `metadata`). The new repo-root `insforge.toml` is non-secret declarative config and
  is safe to commit. SMTP remains disabled — fine for the sign-in-only demo.

Open items / what's needed before sign-in can be verified end-to-end:
- **Demo login user — pending (owner: user).** Only `anon@example.com` exists today and
  it is an *anonymous* user (`email_verified=false`, no password) — not usable for
  username/password sign-in. User said they will create a real demo user later. Until
  then, the scaffold + sign-in UI can be built and unit-tested, but the manual
  "sign in with the configured demo user" step cannot be exercised.
- **Browser-safe frontend env (`.env.local`) — not created yet.** Needs
  `VITE_INSFORGE_URL=https://m5h8zr7r.us-east.insforge.app` and
  `VITE_INSFORGE_ANON_KEY=<browser-safe anon key>`. The anon key is browser-safe but
  was not exposed by CLI `metadata`; retrieve it from the InsForge dashboard
  (API keys) when wiring the SDK. SDK client is `createClient({ baseUrl, anonKey })`.
  **Do not** put the admin `api_key` (`ik_...`) or any provider secret in frontend env.
- **Datadog RUM — optional, no setup required.** Telemetry wrapper must be a no-op when
  browser-safe RUM config is absent. RUM client values only; never Datadog API/app keys.

Heads-up (not Task 1): `docs/CONFIG.md` is untracked, holds live secrets (Datadog key,
TrueFoundry PAT, GitHub PAT), and is **not** in `.gitignore` (only `.env*` is).
CLAUDE.md says do not commit it — recommend adding `docs/CONFIG.md` to `.gitignore`.
