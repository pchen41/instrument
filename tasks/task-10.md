# Task 10: Implement Datadog alert ingestion and incident lifecycle

## Status

Not started.

## Context

Datadog webhooks are template-driven. The ERD defines the minimum JSON payload and mapping rules Instrument expects.

Depends on Tasks 3, 4, and 5.

## Requirements

- Add a Datadog webhook handler.
- Authenticate Datadog webhooks using the configured shared secret/custom header or supported Datadog auth method.
- Store redacted webhook records in `inbound_webhooks` only after verification status is known.
- Do not create incidents, alert events, or jobs unless `signature_valid = true`.
- Normalize webhook payloads into `datadog_alert_events`.
- Synthesize:
  - `external_delivery_id`
  - `alert_transition_key`
  - `alert_correlation_key`
  - `provider_correlation_key`
- Map Datadog transitions:
  - `Recovered` -> `resolved`
  - Triggered/re-triggered/warn/no-data/renotify demo states -> `firing`
- Create or update the current open incident for the configured demo service using `incident_correlation_key`.
- Resolve incidents when the alert recovers.
- Capture alert state, incident state, service, title, description, source, start time, key signals, timeline, and source event links.
- Snapshot `workspace_settings.investigation_start_mode` on incident creation.
- Implement investigation-start behavior:
  - `manual`: wait for a human.
  - `auto`: enqueue investigation for every firing alert.
  - `smart`: enqueue for important/clear-cut demo alerts, such as the TrueFoundry reliability monitor or configured rule.
- Mark automatically started investigations with `started_automatically = true`.
- Emit `app_events` for incident creation, update, resolution, and investigation start.

## Acceptance Criteria

- Invalid or missing Datadog webhook auth prevents downstream processing.
- Replayed Datadog webhooks do not duplicate alert events or incidents.
- Firing alerts create or update active incidents.
- Recovery alerts resolve incidents and keep them visible in the resolved/archive view.
- Manual mode never starts investigations automatically.
- Auto mode starts every firing alert investigation.
- Smart mode starts the reliability-demo alert automatically and leaves ambiguous alerts waiting.
- Changing the investigation-start setting does not affect investigations already in flight.

## Automated Tests

- Add Datadog payload mapping tests using the ERD minimum JSON contract.
- Add auth failure tests.
- Add transition mapping tests.
- Add incident idempotency tests for replayed transition keys and repeated firing updates.
- Add start-mode tests for manual, auto, and smart.

## Manual Verification

- Send a firing Datadog webhook fixture.
- Confirm an incident appears in active incidents.
- Switch modes and send fixtures to confirm start behavior.
- Send a recovery fixture and confirm the incident moves to resolved.

## Progress Notes

- Update this section with webhook URL, expected Datadog template, auth method, and smart-mode rule.
