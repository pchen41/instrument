# Task 10: Implement Datadog alert ingestion and incident lifecycle

## Status

Not started.

## Context

Datadog webhooks are template-driven. The ERD defines the minimum JSON payload and mapping rules Instrument expects.

Depends on Tasks 3, 4, 5A, and 5D. Task 11 consumes created incidents for
investigation.

## Requirements

- Add a Datadog webhook handler.
- Identify the target workspace before writing `inbound_webhooks`; for the first
  slice this may be the single configured workspace, but the handler should
  document whether it uses a workspace-specific URL, configured default
  workspace, or another routing mechanism.
- Authenticate Datadog webhooks using the configured shared secret/custom header or supported Datadog auth method.
- Treat `inbound_webhooks.signature_valid` as "webhook authentication passed" for
  Datadog. Datadog payloads are template-driven and may use a shared
  secret/custom header rather than a GitHub-style HMAC signature.
- Store redacted webhook records in `inbound_webhooks` only after verification status is known.
- Do not create incidents or jobs unless `signature_valid = true`.
- Fold Datadog alert normalization into `inbound_webhooks`,
  `incidents.alert_payload_summary`, and `evidence_items`; do not create
  `datadog_alert_events`.
- Synthesize:
  - `external_delivery_id`
  - `alert_transition_key`
  - `incident_correlation_key`
  - `provider_correlation_key`
- Parse `trace_id` and `request_id` when present in the configured Datadog
  webhook payload so investigations can use them to find Datadog and TrueFoundry
  evidence.
- Map Datadog transitions:
  - `Recovered` -> `resolved`
  - Triggered/re-triggered/warn/no-data/renotify first-slice states -> `firing`
- Create or update the current open incident for the configured service using
  `incident_correlation_key`.
- Resolve incidents when the alert recovers.
- Capture alert state, incident state, service, title, description, source, start time, key signals, timeline, and source event links.
- Snapshot `workspaces.investigation_start_mode` on incident creation.
- Implement investigation-start behavior:
  - `manual`: wait for a human.
  - `auto`: enqueue investigation for every firing alert.
  - `smart`: enqueue for important/clear-cut reliability alerts, such as the
    TrueFoundry reliability monitor or configured rule.
- Smart mode must use pre-investigation alert metadata, monitor identity, tags,
  or `workspaces.smart_start_rules`. Do not copy the prototype's
  post-investigation confidence heuristic, because confidence is only known
  after investigation.
- Mark automatically started investigations with `started_automatically = true`.
- Update incident timestamps and linked job `progress_version` values so Task 4
  polling can surface incident creation, update, resolution, and investigation
  start.

## Acceptance Criteria

- Invalid or missing Datadog webhook auth prevents downstream processing.
- Replayed Datadog webhooks do not duplicate webhook deliveries, incident
  updates, or investigation jobs.
- Firing alerts create or update active incidents.
- Recovery alerts resolve incidents and keep them visible in the resolved/archive view.
- The first slice does not add a manual incident-resolve button; resolution is
  driven by authenticated Datadog recovery webhooks.
- Manual mode never starts investigations automatically.
- Auto mode starts every firing alert investigation.
- Smart mode starts the reliability-validation alert automatically and leaves
  ambiguous alerts waiting.
- Changing the investigation-start setting does not affect investigations already in flight.

## Automated Tests

- Add Datadog payload mapping tests using the ERD minimum JSON contract.
- Add auth failure tests.
- Add transition mapping tests.
- Add incident idempotency tests for replayed transition keys and repeated firing updates.
- Add start-mode tests for manual, auto, and smart.
- Add tests proving trace/request IDs from the Datadog webhook are preserved in
  incident signals or evidence input for investigation.

## Manual Verification

- Send a firing Datadog webhook fixture.
- For local development, use a webhook tunnel such as ngrok or send
  authenticated fixture requests directly to the local handler.
- Confirm an incident appears in active incidents.
- Switch modes and send fixtures to confirm start behavior.
- Send a recovery fixture and confirm the incident moves to resolved.

## Progress Notes

- Update this section with webhook URL, expected Datadog template, auth method, and smart-mode rule.
