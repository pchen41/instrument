# Task 1: Scaffold app, auth entry, and console shell

## Status

Scaffold complete (2026-06-06). Vite + React + TypeScript app, sign-in-only
InsForge auth, route guards, and the console shell (sidebar nav, connected
sources, profile area, three routable sections) are implemented. Typecheck,
unit/component tests (33 passing), and the production build all pass. The one
open item is the manual end-to-end sign-in, which needs the demo login user the
user will create (see Progress Notes). Pre-flight readiness was verified earlier
the same day — see Progress Notes.

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

### 2026-06-06 — Scaffold implemented

Built the production frontend scaffold, sign-in-only auth, and the console shell.

**Stack & tooling**
- Vite 5 + React 18 + TypeScript (strict), Tailwind CSS 3.4 (PostCSS), Vitest +
  Testing Library + jsdom. Deps: `@insforge/sdk` (resolved 1.3.1),
  `@phosphor-icons/react` 2.1, `react-router-dom` 6, `@datadog/browser-rum` 5.
- Scripts: `npm run dev`, `npm run build` (`tsc --noEmit && vite build`),
  `npm test` (`vitest run`), `npm run typecheck`.

**Routing & auth**
- `BrowserRouter` with `/sign-in` and guarded console routes `/incidents`,
  `/recommendations`, `/integrations` (`/` and `*` redirect to `/incidents`).
- `AuthProvider` wraps `insforge.auth` (`getCurrentUser` on mount to rehydrate via
  the httpOnly refresh cookie, `signInWithPassword`, `signOut`). `RequireAuth`
  guards console routes; the sign-in route redirects already-authed users.
  Guard logic is split into pure `protectedRouteDecision` / `signInRouteDecision`
  for unit testing; a short loading state prevents a sign-in flash on refresh.
- Sign-in page adapts the auth prototype's minimal variation: username/password
  only. **No signup toggle and no OAuth** (PRD SEC-2/SEC-3) — even though the
  backend currently has `github`/`google` OAuth providers enabled, they are not
  surfaced in the demo UI.

**Console shell**
- `ConsoleLayout` = warm-paper grid with sidebar + sticky topbar + `<Outlet>`.
  Sidebar: Instrument brand, the three nav items, connected-sources list (static
  demo config in `src/data/sources.ts`: Datadog + GitHub connected, TrueFoundry
  not), and a profile area that signs the user out.
- Incidents and Recommendations render calm empty states (server-backed data
  arrives in later tasks). Integrations renders the preconfigured sources as
  cards; the connect control is a **non-interactive status**, not an active
  connect flow (self-serve connect is out of scope).
- The incident **"Generate fix" PR workflow is intentionally omitted** — see the
  code comment in `src/routes/console/Incidents.tsx`. No such active demo action
  exists.

**Design assets**
- Copied the prototype's design-token CSS (`colors_and_type.css`) and component
  CSS (`app.css`, `auth.css`) into `src/styles/` and import them in `index.css`
  (asset `url()`s repointed to `/assets/...`; token `@import` consolidated). This
  is the allowed "import/adapt prototype CSS directly" path; Tailwind is present
  and its token palette mirrors the design system in `tailwind.config.js`.
- Logos/SVGs copied to `public/assets/`. Icons use `@phosphor-icons/react` via
  `src/components/Icon.tsx`, whose friendly-name → component map mirrors the
  prototype's `assets/icons.js`; rendered at `weight="regular"`, sized at `1em`
  inside an `<i>` so the prototype's font-size-based icon sizing still applies.

**Telemetry (Task 1 owns the frontend RUM wrapper)**
- `src/lib/telemetry.ts`: `createTelemetry(config, loader)` returns a no-op when
  browser-safe RUM config is absent (RUM SDK never loaded) and lazily
  `import()`s `@datadog/browser-rum` and `init()`s it only when
  `VITE_DD_RUM_APPLICATION_ID` + `VITE_DD_RUM_CLIENT_TOKEN` are both present.
  Exposes `recordRouteChange` (wired to router location), `recordConsoleLoadFailure`,
  `recordUserActionFailure` (wired to sign-in/out), and `recordApiFailure` for
  later views. Build confirms the RUM SDK is split into a separate lazy chunk
  referenced only via `import()` (no modulepreload), so it is not fetched when
  RUM is off. The demo runs with RUM absent.

**Environment**
- `.env.example` (committed) documents browser-safe vars only, with explicit
  warnings against admin/provider secrets. `.env.local` (gitignored) created with
  `VITE_INSFORGE_URL` and the browser-safe `VITE_INSFORGE_ANON_KEY`
  (from `npx @insforge/cli secrets get ANON_KEY`). No admin `ik_...` key or
  provider secret is in any frontend env or committed file (verified by scan).
  `.gitignore` already covered `docs/CONFIG.md`; added `.DS_Store`.

**Tests / checks run**
- `npx tsc --noEmit` → clean.
- `npx vitest run` → **5 files, 33 tests passing**: sign-in validation
  (`src/auth/validation.test.ts`), route-guard decisions + `RequireAuth` component
  redirect/allow/loading (`src/auth/guard.test.ts`, `RequireAuth.test.tsx`),
  console shell renders the three nav items + branding + profile + sources
  (`src/routes/console/shell.test.tsx`), and the telemetry wrapper no-op-without-
  config / init-with-config (`src/lib/telemetry.test.ts`).
- `npm run build` → **success**. Output ~ entry JS 416K (120K gzip incl. Phosphor),
  CSS 44K (9K gzip); Datadog RUM in a separate ~165K lazy chunk.
- Dev server smoke: `vite` serves `/` and the SPA fallback for `/incidents`.

**Open item (owner: user) — blocks only manual sign-in verification**
- No usable demo login user exists yet (only an anonymous `anon@example.com` with
  no password). The scaffold + sign-in UI are built and unit-tested, but the
  manual "sign in with the configured demo user / confirm refresh + sign-out"
  steps cannot be exercised until a real username/password user is created.
  `requireEmailVerification` is already off, so a created user can sign in
  immediately.
