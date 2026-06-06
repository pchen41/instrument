# Task 1: Scaffold app, auth entry, and console shell

## Status

Not started.

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
- Add environment examples for browser-safe InsForge values only.

## Acceptance Criteria

- A developer can install dependencies, run the app locally, and see the sign-in page and console shell.
- Unauthenticated users are directed to sign in; authenticated users can reach the console.
- The console shell matches the visual direction of the prototype: warm paper background, Instrument branding, calm state palette, sidebar navigation, and dense operational layout.
- The three console sections exist as routable views, even if they initially render empty states.
- No signup or OAuth setup flow is required for the demo unless the PRD changes.
- No incident "Generate fix" workflow is available as an active demo action.

## Automated Tests

- Add unit tests for auth route guards and sign-in form validation.
- Add a smoke/component test that renders the console shell and verifies the three navigation items.
- Add a build check in the task notes once it passes.

## Manual Verification

- Run the dev server.
- Sign in with the configured demo user.
- Confirm refresh preserves the authenticated console route.
- Confirm sign-out returns to the auth entry.

## Progress Notes

- Update this section with commands run, test results, and any deviations from the design prototype.
