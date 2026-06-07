// Read helpers / documented query shapes for the console list + detail views.
// Every read goes through an authenticated @insforge/sdk client, so RLS scopes
// results to the caller's workspace — these helpers never filter workspace_id
// themselves. JSON columns (steps, signals, hypotheses, ...) are typed via the
// schemas in ../lib/schemas and can be validated with validateColumn before use.
import { insforge } from '../lib/insforge';
import type {
  IncidentCorrelatedChange,
  IncidentHypothesis,
  IncidentSignal,
  IncidentTimelineEntry,
  JobAttempt,
  JobPhase,
  RecommendationLifecycleEvent,
  RecommendationStep,
} from '../lib/schemas';

type Client = typeof insforge;

// Recommendation states shown in the archive (everything that is not active).
export const ARCHIVED_RECOMMENDATION_STATES = ['accepted', 'dismissed', 'outdated'] as const;

export type IncidentDisplayState = 'new' | 'investigating' | 'complete' | 'failed';

// ---- Row shapes (lightweight; JSON columns typed via ../lib/schemas) --------

export interface IncidentListItem {
  id: string;
  title: string;
  service_name: string | null;
  alert_state: 'firing' | 'resolved';
  incident_state: 'active' | 'resolved';
  started_automatically: boolean;
  investigation_job_id: string | null;
  started_at: string;
  resolved_at: string | null;
  updated_at: string;
}

export interface IncidentDetail extends IncidentListItem {
  external_alert_key: string;
  incident_correlation_key: string;
  datadog_url: string | null;
  description: string | null;
  source: string;
  signals: IncidentSignal[];
  timeline: IncidentTimelineEntry[];
  hypotheses: IncidentHypothesis[];
  correlated_changes: IncidentCorrelatedChange[];
  alert_payload_summary: Record<string, unknown>;
}

export type JobState = 'queued' | 'running' | 'retrying' | 'failed' | 'succeeded';

export interface JobSummary {
  id: string;
  job_type: string;
  state: JobState;
  safe_to_retry: boolean;
  attempt_count: number;
  max_attempts: number;
  phases: JobPhase[];
  attempts: JobAttempt[];
  error_code: string | null;
  error_summary: string | null;
  failure_source: string | null;
  failure_integration_id: string | null;
  progress_version: number;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

/** Job states that mean work is still in flight (drives polling + the live UI). */
export const ACTIVE_JOB_STATES: readonly JobState[] = ['queued', 'running', 'retrying'];
export function isActiveJobState(state: JobState | null | undefined): boolean {
  return !!state && ACTIVE_JOB_STATES.includes(state);
}

// One column list reused by every job read so detail + list see the same shape.
const JOB_SUMMARY_COLUMNS =
  'id, job_type, state, safe_to_retry, attempt_count, max_attempts, phases, attempts, ' +
  'error_code, error_summary, failure_source, failure_integration_id, progress_version, ' +
  'started_at, completed_at, updated_at';

export interface EvidenceItem {
  id: string;
  source_type: string;
  title: string;
  summary: string;
  uri: string | null;
  external_id: string | null;
  verification_state: string;
}

export interface RecommendationListItem {
  id: string;
  title: string;
  category: 'instrumentation' | 'alert' | 'pr_review';
  state: 'active' | 'accepted' | 'dismissed' | 'outdated';
  service_name: string | null;
  confidence: 'high' | 'likely' | 'low' | null;
  proposed_next_step: string;
  updated_at: string;
}

export interface RecommendationDetail extends RecommendationListItem {
  rationale: string;
  environment: string | null;
  affected_code_path: string | null;
  affected_runtime_path: string | null;
  steps: RecommendationStep[];
  lifecycle_events: RecommendationLifecycleEvent[];
  outdated_reason: string | null;
}

export interface PullRequestMeta {
  id: string;
  external_pr_number: number;
  title: string;
  author_login: string | null;
  state: string;
  html_url: string | null;
  head_branch: string;
}

export interface PrReviewComment {
  id: string;
  file_path: string;
  line_number: number;
  issue_type: string;
  body: string;
  suggested_code: string | null;
  status: string;
  posted_at: string | null;
}

// ---- Incidents --------------------------------------------------------------

const INCIDENT_LIST_COLUMNS =
  'id, title, service_name, alert_state, incident_state, started_automatically, investigation_job_id, started_at, resolved_at, updated_at';

/** Active incidents, newest first. */
export function listActiveIncidents(client: Client = insforge) {
  return client.database
    .from('incidents')
    .select(INCIDENT_LIST_COLUMNS)
    .eq('incident_state', 'active')
    .order('started_at', { ascending: false });
}

/** Resolved incidents, most recently resolved first. */
export function listResolvedIncidents(client: Client = insforge) {
  return client.database
    .from('incidents')
    .select(INCIDENT_LIST_COLUMNS)
    .eq('incident_state', 'resolved')
    .order('resolved_at', { ascending: false });
}

/**
 * Incident detail: the incident, its linked investigation job (if any), and the
 * evidence items that cite it. Separate scoped reads (rather than PostgREST
 * embedding) keep this unambiguous across the several incident->jobs FKs.
 */
export async function getIncidentDetail(
  id: string,
  client: Client = insforge,
): Promise<{
  data: { incident: IncidentDetail; job: JobSummary | null; evidence: EvidenceItem[] } | null;
  error: unknown;
}> {
  const incidentRes = await client.database.from('incidents').select('*').eq('id', id).maybeSingle();
  if (incidentRes.error || !incidentRes.data) {
    return { data: null, error: incidentRes.error };
  }
  const incident = incidentRes.data as unknown as IncidentDetail;

  let job: JobSummary | null = null;
  if (incident.investigation_job_id) {
    const jobRes = await client.database
      .from('jobs')
      .select(JOB_SUMMARY_COLUMNS)
      .eq('id', incident.investigation_job_id)
      .maybeSingle();
    if (jobRes.error) return { data: null, error: jobRes.error };
    job = (jobRes.data as unknown as JobSummary | null) ?? null;
  }

  const evidenceRes = await client.database
    .from('evidence_items')
    .select('id, source_type, title, summary, uri, external_id, verification_state')
    .eq('subject_type', 'incident')
    .eq('subject_id', id)
    .order('collected_at', { ascending: true });
  if (evidenceRes.error) return { data: null, error: evidenceRes.error };

  return {
    data: { incident, job, evidence: (evidenceRes.data as unknown as EvidenceItem[]) ?? [] },
    error: null,
  };
}

/** Investigation jobs by id, in one `.in()` read (used to map list display states). */
export async function getJobsByIds(
  ids: string[],
  client: Client = insforge,
): Promise<{ data: JobSummary[]; error: unknown }> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return { data: [], error: null };
  const res = await client.database.from('jobs').select(JOB_SUMMARY_COLUMNS).in('id', unique);
  return { data: (res.data as unknown as JobSummary[]) ?? [], error: res.error };
}

/** An incident row paired with its investigation job and the derived display state. */
export interface IncidentWithState {
  incident: IncidentListItem;
  job: JobSummary | null;
  display: IncidentDisplayState;
}

/**
 * Load an incidents list (active or resolved) already joined to investigation
 * job state, so the list renders the same durable display state the detail view
 * shows. Two reads — incidents, then jobs `.in(ids)` — keep it RLS-scoped and
 * avoid ambiguous PostgREST embedding across the several incident->jobs FKs.
 */
export async function loadIncidentsView(
  scope: 'active' | 'resolved',
  client: Client = insforge,
): Promise<{ data: IncidentWithState[]; error: unknown }> {
  const listRes = await (scope === 'active'
    ? listActiveIncidents(client)
    : listResolvedIncidents(client));
  if (listRes.error) return { data: [], error: listRes.error };
  const incidents = (listRes.data as unknown as IncidentListItem[]) ?? [];

  const jobIds = incidents.map((i) => i.investigation_job_id).filter((id): id is string => !!id);
  const jobsRes = await getJobsByIds(jobIds, client);
  if (jobsRes.error) return { data: [], error: jobsRes.error };
  const jobsById = new Map(jobsRes.data.map((j) => [j.id, j]));

  const data = incidents.map((incident) => {
    const job = incident.investigation_job_id
      ? jobsById.get(incident.investigation_job_id) ?? null
      : null;
    return { incident, job, display: incidentDisplayState(incident, job) };
  });
  return { data, error: null };
}

// ---- Recommendations --------------------------------------------------------

const RECOMMENDATION_LIST_COLUMNS =
  'id, title, category, state, service_name, confidence, proposed_next_step, updated_at';

/** Active recommendations, most recently updated first. */
export function listActiveRecommendations(client: Client = insforge) {
  return client.database
    .from('recommendations')
    .select(RECOMMENDATION_LIST_COLUMNS)
    .eq('state', 'active')
    .order('updated_at', { ascending: false });
}

/** Archived recommendations (accepted / dismissed / outdated), newest first. */
export function listArchivedRecommendations(client: Client = insforge) {
  return client.database
    .from('recommendations')
    .select(RECOMMENDATION_LIST_COLUMNS)
    .in('state', ARCHIVED_RECOMMENDATION_STATES as unknown as string[])
    .order('updated_at', { ascending: false });
}

// Columns the recommendation cards render inline (the list cards show steps with
// their generated artifacts, so `steps` and `rationale` come back with the list).
const RECOMMENDATION_CARD_COLUMNS =
  'id, title, category, state, service_name, confidence, proposed_next_step, ' +
  'rationale, steps, outdated_reason, updated_at';

export interface RecommendationCard extends RecommendationListItem {
  rationale: string;
  steps: RecommendationStep[];
  outdated_reason: string | null;
}

/** Active recommendations with steps, for the Open tab cards. */
export async function loadActiveRecommendations(
  client: Client = insforge,
): Promise<{ data: RecommendationCard[]; error: unknown }> {
  const res = await client.database
    .from('recommendations')
    .select(RECOMMENDATION_CARD_COLUMNS)
    .eq('state', 'active')
    .order('updated_at', { ascending: false });
  return { data: (res.data as unknown as RecommendationCard[]) ?? [], error: res.error };
}

/** Archived recommendations (accepted / dismissed / outdated) for the Archive tab. */
export async function loadArchivedRecommendations(
  client: Client = insforge,
): Promise<{ data: RecommendationCard[]; error: unknown }> {
  const res = await client.database
    .from('recommendations')
    .select(RECOMMENDATION_CARD_COLUMNS)
    .in('state', ARCHIVED_RECOMMENDATION_STATES as unknown as string[])
    .order('updated_at', { ascending: false });
  return { data: (res.data as unknown as RecommendationCard[]) ?? [], error: res.error };
}

/**
 * Recommendation detail with step state + generated artifacts (steps JSON) and
 * the evidence items that cite it. Generated PR / draft-monitor results live on
 * `steps`, not in separate tables.
 */
export async function getRecommendationDetail(
  id: string,
  client: Client = insforge,
): Promise<{
  data: { recommendation: RecommendationDetail; evidence: EvidenceItem[] } | null;
  error: unknown;
}> {
  const recRes = await client.database.from('recommendations').select('*').eq('id', id).maybeSingle();
  if (recRes.error || !recRes.data) return { data: null, error: recRes.error };

  const evidenceRes = await client.database
    .from('evidence_items')
    .select('id, source_type, title, summary, uri, external_id, verification_state')
    .eq('subject_type', 'recommendation')
    .eq('subject_id', id);
  if (evidenceRes.error) return { data: null, error: evidenceRes.error };

  return {
    data: {
      recommendation: recRes.data as unknown as RecommendationDetail,
      evidence: (evidenceRes.data as unknown as EvidenceItem[]) ?? [],
    },
    error: null,
  };
}

// ---- PR review records ------------------------------------------------------

/** PR-review recommendations (the cards that record posted review comments). */
export function listPrReviewRecommendations(client: Client = insforge) {
  return client.database
    .from('recommendations')
    .select(RECOMMENDATION_LIST_COLUMNS)
    .eq('category', 'pr_review')
    .order('updated_at', { ascending: false });
}

/**
 * A PR review record: the recommendation, the reviewed PR's metadata, and the
 * posted comments. Comments link to the PR via pull_request_id.
 */
export async function getPrReviewRecord(
  recommendationId: string,
  client: Client = insforge,
): Promise<{
  data: {
    recommendation: RecommendationDetail;
    pullRequest: PullRequestMeta | null;
    comments: PrReviewComment[];
  } | null;
  error: unknown;
}> {
  const recRes = await client.database
    .from('recommendations')
    .select('*')
    .eq('id', recommendationId)
    .maybeSingle();
  if (recRes.error || !recRes.data) return { data: null, error: recRes.error };

  const commentsRes = await client.database
    .from('pr_review_comments')
    .select('id, pull_request_id, file_path, line_number, issue_type, body, suggested_code, status, posted_at')
    .eq('recommendation_id', recommendationId)
    .order('line_number', { ascending: true });
  if (commentsRes.error) return { data: null, error: commentsRes.error };
  const comments = (commentsRes.data as unknown as (PrReviewComment & { pull_request_id: string })[]) ?? [];

  let pullRequest: PullRequestMeta | null = null;
  const prId = comments[0]?.pull_request_id;
  if (prId) {
    const prRes = await client.database
      .from('github_pull_requests')
      .select('id, external_pr_number, title, author_login, state, html_url, head_branch')
      .eq('id', prId)
      .maybeSingle();
    if (prRes.error) return { data: null, error: prRes.error };
    pullRequest = (prRes.data as unknown as PullRequestMeta | null) ?? null;
  }

  return {
    data: { recommendation: recRes.data as unknown as RecommendationDetail, pullRequest, comments },
    error: null,
  };
}

/** Derive the console's incident display state from the incident + its job. */
export function incidentDisplayState(
  incident: Pick<IncidentListItem, 'investigation_job_id'>,
  job: Pick<JobSummary, 'state'> | null,
): IncidentDisplayState {
  if (!incident.investigation_job_id || !job) return 'new';
  if (job.state === 'succeeded') return 'complete';
  if (job.state === 'failed') return 'failed';
  return 'investigating';
}

// ---- Workspace settings (investigation-start mode) --------------------------

export type InvestigationStartMode = 'manual' | 'auto' | 'smart';

export interface WorkspaceSettings {
  id: string;
  slug: string;
  name: string;
  investigation_start_mode: InvestigationStartMode;
  updated_at: string;
}

/** The caller's workspace (single workspace in the first slice; RLS-scoped). */
export async function getWorkspaceSettings(
  client: Client = insforge,
): Promise<{ data: WorkspaceSettings | null; error: unknown }> {
  const res = await client.database
    .from('workspaces')
    .select('id, slug, name, investigation_start_mode, updated_at')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  return { data: (res.data as unknown as WorkspaceSettings | null) ?? null, error: res.error };
}

/**
 * Persist the investigation-start setting on `workspaces`. This is the one
 * mutation the console performs directly: Task 2 grants `authenticated` a
 * column-scoped UPDATE on investigation_start_mode (+ settings audit columns),
 * so it does not need a Task 5A action endpoint. It only touches the setting —
 * investigations already in flight are unaffected (they read the snapshot taken
 * when they started, not this column).
 */
export async function updateInvestigationStartMode(
  workspaceId: string,
  mode: InvestigationStartMode,
  settingsUpdatedBy: string | null,
  client: Client = insforge,
): Promise<{ error: unknown }> {
  const res = await client.database
    .from('workspaces')
    .update({
      investigation_start_mode: mode,
      settings_updated_by: settingsUpdatedBy,
      settings_updated_at: new Date().toISOString(),
    })
    .eq('id', workspaceId);
  return { error: res.error };
}

// ---- Integrations health ----------------------------------------------------

export type IntegrationProvider = 'github' | 'datadog' | 'truefoundry';
export type IntegrationStatus =
  | 'connected'
  | 'disconnected'
  | 'degraded'
  | 'rate_limited'
  | 'missing_credentials';

export interface IntegrationHealth {
  id: string;
  provider: IntegrationProvider;
  status: IntegrationStatus;
  display_name: string;
  last_checked_at: string | null;
  last_error_code: string | null;
  last_error_summary: string | null;
}

/** Integration health for the workspace (RLS-scoped), provider order stable. */
export async function listIntegrations(client: Client = insforge) {
  return client.database
    .from('integrations')
    .select('id, provider, status, display_name, last_checked_at, last_error_code, last_error_summary')
    .order('provider', { ascending: true });
}
