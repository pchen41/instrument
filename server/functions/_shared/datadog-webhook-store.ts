// Deno-side persistence for Datadog webhook ingestion (Task 10). The pure
// decisions (auth, parse, key synthesis, transition + start-mode mapping, bounded
// snapshots) live in server/lib/datadog-webhook.ts; this is the PostgREST IO edge:
// record the delivery, read the configured workspace + start-mode, create/update
// the single open incident per correlation key, resolve it on recovery, enqueue an
// incident_investigation job for auto/smart starts, and persist the alert event as
// evidence (carrying trace_id/request_id for the Task 11 investigation).
//
// Workspace routing (first slice): the single configured workspace. A Datadog
// delivery is not repo-scoped, so there is no allowlist lookup — every
// authenticated delivery attributes to that workspace (documented per ERD).
import { isUniqueViolation } from './agent-runtime.ts';
import { investigationKey } from '../../lib/idempotency.ts';
import { LEASE_FREE } from '../../lib/time.ts';
import {
  type AlertState,
  type DatadogAlert,
  type StartDecision,
  alertTransitionKey,
  buildAlertPayloadSummary,
  buildSignals,
  buildTimelineEntry,
  incidentCorrelationKey,
} from '../../lib/datadog-webhook.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

const MAX_TIMELINE = 50;

export interface DatadogInboundInsert {
  workspaceId: string;
  integrationId: string | null;
  eventType: string;
  eventAction: string | null;
  externalDeliveryId: string;
  providerCorrelationKey: string | null;
  signatureValid: boolean;
  headersRedacted: Record<string, unknown>;
  payloadRedacted: Record<string, unknown>;
  receivedAt: string;
  processingStatus: 'received' | 'ignored' | 'processed' | 'failed';
}

export interface WorkspaceConfig {
  id: string;
  investigationStartMode: 'manual' | 'auto' | 'smart';
  smartStartRules: Record<string, unknown>;
}

export interface IncidentResult {
  incidentId: string | null;
  action: 'created' | 'updated' | 'resolved' | 'duplicate' | 'no_incident';
  /** Persisted creation-time auto-start snapshot (so the handler can recover a
   *  crashed enqueue without re-deciding from the possibly-changed current mode). */
  startedAutomatically?: boolean;
  /** Already-linked investigation job, if any (skip re-enqueue). */
  investigationJobId?: string | null;
}

interface ActiveIncident {
  id: string;
  alert_transition_key: string | null;
  timeline: unknown[];
  signals: { key: string; label: string; value: string }[];
  investigation_job_id: string | null;
  started_automatically: boolean;
}

/** Union existing + new signals by key (so a recovery-only trace/request id is kept and firing signals aren't lost). */
function mergeSignals(existing: { key: string; label: string; value: string }[], next: { key: string; label: string; value: string }[]): { key: string; label: string; value: string }[] {
  const byKey = new Map(existing.map((s) => [s.key, s]));
  for (const s of next) byKey.set(s.key, s);
  return Array.from(byKey.values()).slice(0, 20);
}

export function createDatadogWebhookStore(admin: Admin) {
  const db = admin.database;

  return {
    /** The single configured workspace + its investigation-start settings. Errors THROW (→ 500 → Datadog can be re-driven). */
    async workspaceConfig(): Promise<WorkspaceConfig | null> {
      const { data, error } = await db.from('workspaces').select('id, investigation_start_mode, smart_start_rules').order('created_at', { ascending: true }).limit(1).maybeSingle();
      if (error) throw error;
      if (!data?.id) return null;
      return {
        id: data.id as string,
        investigationStartMode: (data.investigation_start_mode as WorkspaceConfig['investigationStartMode']) ?? 'manual',
        smartStartRules: (data.smart_start_rules as Record<string, unknown>) ?? {},
      };
    },

    /** The workspace's Datadog integration id (for inbound_webhooks attribution), or null. */
    async datadogIntegrationId(workspaceId: string): Promise<string | null> {
      const { data, error } = await db.from('integrations').select('id').eq('workspace_id', workspaceId).eq('provider', 'datadog').limit(1).maybeSingle();
      if (error) throw error;
      return (data?.id as string | undefined) ?? null;
    },

    /**
     * Record the delivery idempotently on (provider, external_delivery_id). Returns
     * `duplicate` = the caller should short-circuit: a delivery already `processed`,
     * or `ignored` while authenticated, is terminal. A row left `received`/`failed`
     * (crash mid-flight) or a previously-rejected unauthenticated row is refreshed
     * and re-processed. (Mirrors the GitHub store; incident upsert is idempotent.)
     */
    async recordDelivery(row: DatadogInboundInsert): Promise<{ id: string; duplicate: boolean }> {
      const insert = {
        workspace_id: row.workspaceId,
        provider: 'datadog',
        integration_id: row.integrationId,
        event_type: row.eventType,
        event_action: row.eventAction,
        external_delivery_id: row.externalDeliveryId,
        provider_correlation_key: row.providerCorrelationKey,
        auth_method: 'shared_secret_header',
        signature_valid: row.signatureValid,
        headers_redacted: row.headersRedacted,
        payload_redacted: row.payloadRedacted,
        received_at: row.receivedAt,
        processing_status: row.processingStatus,
      };
      const { data, error } = await db.from('inbound_webhooks').insert([insert]).select('id');
      if (!error) return { id: (data as { id: string }[])[0].id, duplicate: false };
      if (!isUniqueViolation(error)) throw error;
      const { data: existing, error: selErr } = await db.from('inbound_webhooks').select('id, processing_status, signature_valid').eq('provider', 'datadog').eq('external_delivery_id', row.externalDeliveryId).limit(1).maybeSingle();
      if (selErr) throw selErr;
      if (!existing?.id) throw error;
      const id = existing.id as string;
      const terminal = existing.processing_status === 'processed' || (existing.processing_status === 'ignored' && existing.signature_valid === true);
      if (terminal) return { id, duplicate: true };
      const { error: updErr } = await db.from('inbound_webhooks').update({ ...insert, processed_at: null, error_summary: null }).eq('id', id);
      if (updErr) throw updErr;
      return { id, duplicate: false };
    },

    async markDelivery(id: string, patch: { processingStatus: DatadogInboundInsert['processingStatus']; processedAt?: string; errorSummary?: string | null }): Promise<void> {
      const { error } = await db.from('inbound_webhooks').update({ processing_status: patch.processingStatus, processed_at: patch.processedAt ?? null, error_summary: patch.errorSummary ?? null }).eq('id', id);
      if (error) throw error;
    },

    /** The current OPEN incident for a correlation key (partial unique on active), or null. */
    async activeIncident(workspaceId: string, correlationKey: string): Promise<ActiveIncident | null> {
      const { data, error } = await db.from('incidents').select('id, alert_transition_key, timeline, signals, investigation_job_id, started_automatically').eq('workspace_id', workspaceId).eq('incident_correlation_key', correlationKey).eq('incident_state', 'active').limit(1).maybeSingle();
      if (error) throw error;
      if (!data?.id) return null;
      return {
        id: data.id as string,
        alert_transition_key: (data.alert_transition_key as string | null) ?? null,
        timeline: Array.isArray(data.timeline) ? (data.timeline as unknown[]) : [],
        signals: Array.isArray(data.signals) ? (data.signals as ActiveIncident['signals']) : [],
        investigation_job_id: (data.investigation_job_id as string | null) ?? null,
        started_automatically: data.started_automatically === true,
      };
    },

    /**
     * Create-or-update the open incident for a FIRING alert. A replayed transition
     * (same alert_transition_key on the open incident) is a no-op. Returns the
     * incident id + whether it was created (so the caller enqueues an investigation
     * only on creation, honouring the creation-time start-mode snapshot).
     */
    async firingIncident(args: { workspaceId: string; deliveryId: string; alert: DatadogAlert; mode: WorkspaceConfig['investigationStartMode']; decision: StartDecision; now: string }): Promise<IncidentResult> {
      const { workspaceId, alert, now } = args;
      const correlationKey = incidentCorrelationKey(alert);
      const transitionKey = alertTransitionKey(alert);

      // Apply a firing alert to an EXISTING open incident. Guarded on incident_state
      // (a concurrent recovery may have resolved it); .select() lets us detect 0 rows.
      const applyUpdate = async (inc: ActiveIncident): Promise<IncidentResult | null> => {
        if (inc.alert_transition_key === transitionKey) return { incidentId: inc.id, action: 'duplicate', startedAutomatically: inc.started_automatically, investigationJobId: inc.investigation_job_id };
        const timeline = [...inc.timeline, buildTimelineEntry(alert, 'firing', now)].slice(-MAX_TIMELINE);
        const { data, error } = await db.from('incidents').update({
          webhook_event_id: args.deliveryId,
          alert_transition_key: transitionKey,
          alert_state: 'firing',
          title: alert.title,
          description: alert.message,
          service_name: alert.service,
          environment: alert.environment,
          datadog_event_id: alert.eventId,
          datadog_url: alert.eventUrl,
          signals: mergeSignals(inc.signals, buildSignals(alert)),
          timeline,
          alert_payload_summary: buildAlertPayloadSummary(alert),
          updated_at: now,
        }).eq('id', inc.id).eq('incident_state', 'active').select('id');
        if (error) throw error;
        if (!Array.isArray(data) || data.length === 0) return null; // resolved out from under us → caller inserts fresh
        return { incidentId: inc.id, action: 'updated', startedAutomatically: inc.started_automatically, investigationJobId: inc.investigation_job_id };
      };

      const existing = await this.activeIncident(workspaceId, correlationKey);
      if (existing) {
        const res = await applyUpdate(existing);
        if (res) return res;
      }

      const insert = {
        workspace_id: workspaceId,
        webhook_event_id: args.deliveryId,
        external_alert_key: alert.alertId ?? alert.alertCycleKey ?? correlationKey,
        incident_correlation_key: correlationKey,
        alert_transition_key: transitionKey,
        external_monitor_id: alert.alertId,
        datadog_event_id: alert.eventId,
        datadog_url: alert.eventUrl,
        service_name: alert.service,
        environment: alert.environment,
        title: alert.title,
        description: alert.message,
        source: 'Datadog monitor',
        alert_state: 'firing' as AlertState,
        incident_state: 'active',
        investigation_start_mode_snapshot: args.mode,
        started_automatically: args.decision.automatic,
        signals: buildSignals(alert),
        timeline: [buildTimelineEntry(alert, 'firing', now)],
        alert_payload_summary: buildAlertPayloadSummary(alert),
        started_at: alert.date ?? now,
        created_at: now,
        updated_at: now,
      };
      const { data, error } = await db.from('incidents').insert([insert]).select('id');
      if (!error) return { incidentId: (data as { id: string }[])[0].id, action: 'created', startedAutomatically: args.decision.automatic, investigationJobId: null };
      // Lost a create race on the partial unique index → re-read and APPLY the update
      // (so the losing transition's data isn't dropped), not just acknowledge it.
      if (isUniqueViolation(error)) {
        const again = await this.activeIncident(workspaceId, correlationKey);
        if (again) {
          const res = await applyUpdate(again);
          if (res) return res;
        }
      }
      throw error;
    },

    /** Resolve the open incident on a recovery alert (keeps it visible in the resolved view). No-op if none open. */
    async resolveIncident(args: { workspaceId: string; deliveryId: string; alert: DatadogAlert; now: string }): Promise<IncidentResult> {
      const { workspaceId, alert, now } = args;
      const correlationKey = incidentCorrelationKey(alert);
      const existing = await this.activeIncident(workspaceId, correlationKey);
      if (!existing) return { incidentId: null, action: 'no_incident' };
      const timeline = [...existing.timeline, buildTimelineEntry(alert, 'resolved', now)].slice(-MAX_TIMELINE);
      const { error } = await db.from('incidents').update({
        webhook_event_id: args.deliveryId,
        alert_transition_key: alertTransitionKey(alert),
        alert_state: 'resolved',
        incident_state: 'resolved',
        resolved_at: now,
        signals: mergeSignals(existing.signals, buildSignals(alert)), // keep recovery-only trace/request ids
        timeline,
        alert_payload_summary: buildAlertPayloadSummary(alert),
        updated_at: now,
      }).eq('id', existing.id).eq('incident_state', 'active');
      if (error) throw error;
      return { incidentId: existing.id, action: 'resolved' };
    },

    /**
     * Enqueue an incident_investigation job idempotently (one per incident) and link
     * it. `started_automatically` is already set on the incident at creation; here we
     * attach the job id so Task 4 polling surfaces the investigation start.
     */
    async enqueueInvestigation(args: { workspaceId: string; incidentId: string; deliveryId: string; alert: DatadogAlert; automatic: boolean; now: string }): Promise<{ jobId: string; deduped: boolean }> {
      const key = investigationKey(args.incidentId);
      const { data: existing, error: exErr } = await db.from('jobs').select('id').eq('workspace_id', args.workspaceId).eq('job_type', 'incident_investigation').eq('idempotency_key', key).limit(1).maybeSingle();
      if (exErr) throw exErr;
      if (existing?.id) {
        await db.from('incidents').update({ investigation_job_id: existing.id, updated_at: args.now }).eq('id', args.incidentId);
        return { jobId: existing.id as string, deduped: true };
      }
      const { alert } = args;
      const { data, error } = await db.from('jobs').insert([{
        workspace_id: args.workspaceId,
        job_type: 'incident_investigation',
        state: 'queued',
        target_type: 'incident',
        target_id: args.incidentId,
        idempotency_key: key,
        created_by: null,
        safe_to_retry: true,
        attempt_count: 0,
        max_attempts: 3,
        retry_policy: {},
        phases: [],
        attempts: [],
        audit_events: [{ at: args.now, kind: 'enqueued', summary: `Auto-started investigation for ${alert.service ?? 'service'} alert.` }],
        trigger_summary: {
          source: 'datadog_alert',
          webhook_event_id: args.deliveryId,
          incident_id: args.incidentId,
          service_name: alert.service,
          monitor_id: alert.alertId,
          trace_id: alert.traceId,
          request_id: alert.requestId,
          started_automatically: args.automatic,
        },
        queued_at: args.now,
        next_run_at: args.now,
        lease_expires_at: LEASE_FREE,
        locked_by: null,
        progress_version: 1,
      }]).select('id');
      if (error) {
        if (isUniqueViolation(error)) {
          const { data: row } = await db.from('jobs').select('id').eq('workspace_id', args.workspaceId).eq('job_type', 'incident_investigation').eq('idempotency_key', key).limit(1).maybeSingle();
          if (row?.id) {
            await db.from('incidents').update({ investigation_job_id: row.id, updated_at: args.now }).eq('id', args.incidentId);
            return { jobId: row.id as string, deduped: true };
          }
        }
        throw error;
      }
      const jobId = (data as { id: string }[])[0].id;
      await db.from('incidents').update({ investigation_job_id: jobId, updated_at: args.now }).eq('id', args.incidentId);
      return { jobId, deduped: false };
    },

    /** Persist the alert event as evidence (trace_id/request_id carried for investigation). Best-effort. */
    async recordAlertEvidence(args: { workspaceId: string; incidentId: string; alert: DatadogAlert; now: string }): Promise<void> {
      const { alert } = args;
      const contentHash = `${args.incidentId}:${alertTransitionKey(alert)}`;
      // No unique index covers webhook evidence (collected_by_job_id is null), so
      // guard idempotency with an explicit select — a reprocessed delivery (crash
      // recovery / 'updated' path) must not insert a duplicate evidence row.
      const { data: dup, error: dupErr } = await db.from('evidence_items').select('id').eq('workspace_id', args.workspaceId).eq('content_hash', contentHash).limit(1).maybeSingle();
      if (dupErr) throw dupErr;
      if (dup?.id) return;
      const row = {
        workspace_id: args.workspaceId,
        source_type: 'datadog_alert_event',
        source_provider: 'datadog',
        subject_type: 'incident',
        subject_id: args.incidentId,
        subject_key: `dd_alert:${args.incidentId}:${alertTransitionKey(alert)}`.slice(0, 200),
        claim_type: 'fact',
        external_id: alert.eventId ?? alertTransitionKey(alert),
        uri: alert.eventUrl,
        title: `Datadog alert: ${alert.title}`.slice(0, 200),
        summary: `${alert.transition ?? 'transition'} on ${alert.service ?? 'service'}`.slice(0, 300),
        payload: { ...buildAlertPayloadSummary(alert), trace_id: alert.traceId, request_id: alert.requestId },
        content_hash: `${args.incidentId}:${alertTransitionKey(alert)}`,
        verification_state: 'verified',
        observed_at: alert.date ?? args.now,
        collected_at: args.now,
      };
      const { error } = await db.from('evidence_items').insert([row]);
      if (error && !isUniqueViolation(error)) throw error;
    },
  };
}
