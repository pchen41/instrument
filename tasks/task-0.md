# Task 0: Verify first-slice provisioning and external integration readiness

## Status

Not started.

## Context

This task verifies the external setup that later tasks assume. It should happen
before backend runtime work so missing credentials, webhook settings, or provider
registrations are discovered early rather than during the reliability validation
path.

Read `AGENTS.md`, `docs/PRD.md`, and `docs/ERD.md` before starting. Use the
`insforge-cli` skill for InsForge checks and do not hardcode or commit secrets.

## Requirements

- Verify the linked InsForge project and document the project/app URL in progress
  notes.
- Verify or document creation of the configured demo auth user required by the
  first slice.
- Verify required server-side secret references exist for GitHub, Datadog,
  TrueFoundry, and InsForge admin/service access, without printing or storing raw
  secret values in task notes.
- Verify the configured primary GitHub repository, webhook secret, and token or
  app credentials can support:
  - repository, file, PR, diff, and commit reads
  - scoped PR review comments
  - branch/file/PR creation for approved recommendation PRs
- Verify Datadog site/configuration, webhook authentication method, and the
  expected webhook payload template fields from `docs/ERD.md`.
- Verify Datadog credentials can support monitor/log/metric/service reads and
  draft monitor creation when Task 9 runs.
- Verify the reliability-validation Datadog monitor approach is documented as a
  preconfigured/published monitor outside Instrument's draft-monitor flow.
- Verify TrueFoundry account/control-plane/gateway values, model provider name,
  selected model names, and AI Gateway/Agent API access.
- Verify whether GitHub MCP and Datadog MCP registrations already exist in the
  TrueFoundry MCP Gateway. If they do not, document what Task 5C must create or
  configure.
- Document the demo hosting plan for the Instrument observability MCP server:
  Render web service, `/mcp` URL, `/healthz` URL, shared bearer/header auth
  secret name, and manual TrueFoundry MCP Gateway registration. Record only
  non-secret names, URLs, FQNs, and redacted readiness status.
- Document local development constraints, including webhook tunnel requirements
  and whether the Instrument observability MCP server needs a tunnel before the
  Render deployment is available.

## Acceptance Criteria

- A future agent can tell which external systems are ready, degraded, or missing
  before starting Task 5A.
- Missing provider setup is recorded as an explicit blocker or follow-up, not
  discovered implicitly by a later workflow task.
- No raw API keys, tokens, webhook secrets, PATs, VATs, or InsForge admin keys
  appear in committed files or task notes.
- The reliability-validation Datadog monitor plan is documented without adding a
  manual incident-resolve button or fallback UI action.

## Automated Tests

- No automated tests are required for this task unless the repository already has
  secret/config validation helpers.

## Manual Verification

- Run read-only InsForge project/auth/metadata checks.
- Confirm provider credentials and webhook settings in their respective provider
  consoles or through read-only API calls.
- Record only redacted status summaries in progress notes.

## Progress Notes

- Update this section with redacted readiness status, provider setup notes, and
  unresolved provisioning blockers.
