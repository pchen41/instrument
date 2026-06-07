// Datadog webhook ingestion endpoint (Task 10). The configured Datadog monitor
// webhook posts the template-driven minimum JSON contract here with a shared-secret
// custom header. Strict order so an unauthenticated or malformed delivery never
// creates an incident or job:
//
//   cap body  →  constant-time check of X-Instrument-Webhook-Token
//   →  invalid: record a minimal rejected row (no payload trust) + 401
//   →  valid: parse contract  →  record delivery (idempotent on synth delivery id)
//   →  firing: create/update the open incident (one per correlation key); on
//      CREATE, decide investigation start (manual/auto/smart) from creation-time
//      mode + pre-investigation metadata, enqueue incident_investigation if so
//   →  recovered: resolve the open incident (kept visible in resolved view)
//   →  persist the alert event as evidence (trace_id/request_id for investigation)
//
// Workspace routing (first slice): the single configured workspace — a Datadog
// delivery is not repo-scoped, so every authenticated delivery attributes there.
// The investigation itself runs in the durable worker (Task 11); this handler only
// ingests + decides start, then returns a fast 2xx.
import { createAdminClient } from 'npm:@insforge/sdk';
import { json, preflight } from '../_shared/http.ts';
import { createDatadogWebhookStore } from '../_shared/datadog-webhook-store.ts';
import { createConsoleSink, createInstrumentation } from '../../lib/instrumentation.ts';
import { createDatadogClient } from '../_shared/datadog-client.ts';
import { isoSeconds, systemClock } from '../../lib/time.ts';
import {
  type SmartStartRules,
  DATADOG_WEBHOOK_TOKEN_HEADER,
  boundedDatadogPayload,
  decideInvestigationStart,
  externalDeliveryId,
  incidentCorrelationKey,
  mapAlertState,
  parseDatadogAlert,
  redactedDatadogHeaders,
  verifyWebhookSecret,
} from '../../lib/datadog-webhook.ts';

// deno-lint-ignore no-explicit-any
declare const Deno: any;

// Cap the body before auth/parse — both run on unauthenticated input. Datadog
// alert payloads are small templates; 1 MB is generous.
const MAX_BODY_BYTES = 1024 * 1024;

export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const baseUrl = Deno.env.get('INSFORGE_BASE_URL');
  const apiKey = Deno.env.get('API_KEY');
  if (!baseUrl || !apiKey) return json({ error: 'server_misconfigured' }, 500);

  // Fail CLOSED: with no configured secret we cannot authenticate any delivery.
  const secret = Deno.env.get('DATADOG_WEBHOOK_SECRET');
  if (!secret) return json({ error: 'server_misconfigured' }, 500);

  const declaredLen = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) return json({ error: 'payload_too_large' }, 413);
  const bodyBytes = new Uint8Array(await req.arrayBuffer());
  if (bodyBytes.byteLength > MAX_BODY_BYTES) return json({ error: 'payload_too_large' }, 413);
  const bodyText = new TextDecoder().decode(bodyBytes);

  const tokenValid = verifyWebhookSecret(secret, req.headers.get(DATADOG_WEBHOOK_TOKEN_HEADER));
  const headersRedacted = redactedDatadogHeaders((n) => req.headers.get(n));

  const admin = createAdminClient({ baseUrl, apiKey });
  const store = createDatadogWebhookStore(admin);
  const datadog = createDatadogClient();
  const instrument = createInstrumentation({ service: datadog.service, environment: datadog.environment, enabled: true }, createConsoleSink()).child({ path: 'server', fn: 'datadog-webhook' });
  const endSpan = instrument.span('server.datadog_webhook', { tokenValid });

  let deliveryRowId: string | null = null;
  try {
    const now = isoSeconds(systemClock.now());
    const ws = await store.workspaceConfig();
    if (!ws) return json({ error: 'no_workspace' }, 500);

    // --- Unauthenticated: record a minimal rejected row, no payload trust. ------
    if (!tokenValid) {
      await store.recordDelivery({
        workspaceId: ws.id,
        integrationId: null,
        eventType: 'monitor_alert',
        eventAction: null,
        // Coarse hourly bucket (NOT a body hash) so an attacker varying the body
        // can't write unbounded rejected rows — at most one rejected row per hour.
        externalDeliveryId: `dd:rejected:${now.slice(0, 13)}`,
        providerCorrelationKey: null,
        signatureValid: false,
        headersRedacted,
        payloadRedacted: { rejected: 'invalid_token' },
        receivedAt: now,
        processingStatus: 'ignored',
      });
      instrument.log('warn', 'datadog_webhook.rejected', { reason: 'invalid_token' });
      endSpan({ ok: false, rejected: true });
      return json({ error: 'invalid_token' }, 401);
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      return json({ error: 'bad_json' }, 400);
    }

    const alert = parseDatadogAlert(payload, now);
    const state = mapAlertState(alert.transition);
    const correlationKey = incidentCorrelationKey(alert);
    const integrationId = await store.datadogIntegrationId(ws.id);

    const delivery = await store.recordDelivery({
      workspaceId: ws.id,
      integrationId,
      eventType: 'monitor_alert',
      eventAction: alert.transition,
      externalDeliveryId: externalDeliveryId(alert),
      providerCorrelationKey: correlationKey,
      signatureValid: true,
      headersRedacted,
      payloadRedacted: boundedDatadogPayload(alert),
      receivedAt: now,
      processingStatus: 'received',
    });
    if (delivery.duplicate) {
      endSpan({ ok: true, deduped: true });
      return json({ ok: true, deduped: true });
    }
    deliveryRowId = delivery.id;

    if (state === 'resolved') {
      const res = await store.resolveIncident({ workspaceId: ws.id, deliveryId: delivery.id, alert, now });
      if (res.incidentId) await store.recordAlertEvidence({ workspaceId: ws.id, incidentId: res.incidentId, alert, now });
      await store.markDelivery(delivery.id, { processingStatus: 'processed', processedAt: isoSeconds(systemClock.now()) });
      endSpan({ ok: true, state, incident: res.action });
      return json({ ok: true, state, incident: res.action, incident_id: res.incidentId });
    }

    // Firing: create/update the open incident. The current mode decides ONLY the
    // brand-new incident's started_automatically snapshot; the enqueue below reads
    // that PERSISTED snapshot, not the live decision.
    const decision = decideInvestigationStart(ws.investigationStartMode, state, alert, ws.smartStartRules as SmartStartRules);
    const inc = await store.firingIncident({ workspaceId: ws.id, deliveryId: delivery.id, alert, mode: ws.investigationStartMode, decision, now });

    let jobId: string | null = inc.investigationJobId ?? null;
    if (inc.incidentId) {
      await store.recordAlertEvidence({ workspaceId: ws.id, incidentId: inc.incidentId, alert, now });
      // Enqueue when the incident's PERSISTED snapshot wants an auto-start and it
      // has no job yet. This is crash-safe (recovers a create that died before the
      // enqueue, since a replay returns the persisted flags), never re-enqueues a
      // re-fire (job already linked), and ignores a later mode flip (snapshot governs).
      if (inc.startedAutomatically && !inc.investigationJobId) {
        const enq = await store.enqueueInvestigation({ workspaceId: ws.id, incidentId: inc.incidentId, deliveryId: delivery.id, alert, automatic: true, now });
        jobId = enq.jobId;
      }
    }
    await store.markDelivery(delivery.id, { processingStatus: 'processed', processedAt: isoSeconds(systemClock.now()) });
    endSpan({ ok: true, state, incident: inc.action, started: !!inc.startedAutomatically, reason: decision.reason });
    return json({ ok: true, state, incident: inc.action, incident_id: inc.incidentId, investigation_job_id: jobId, started_automatically: !!inc.startedAutomatically });
  } catch (err) {
    if (deliveryRowId) {
      try {
        await store.markDelivery(deliveryRowId, { processingStatus: 'failed', errorSummary: 'processing_error' });
      } catch {
        /* best-effort */
      }
    }
    instrument.log('error', 'datadog_webhook.error', { error: err instanceof Error ? err.message : String(err) });
    endSpan({ ok: false });
    return json({ error: 'internal' }, 500);
  }
}
