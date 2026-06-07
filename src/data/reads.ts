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

export interface JobSummary {
  id: string;
  job_type: string;
  state: 'queued' | 'running' | 'retrying' | 'failed' | 'succeeded';
  safe_to_retry: boolean;
  attempt_count: number;
  phases: unknown[];
  attempts: unknown[];
  error_summary: string | null;
  updated_at: string;
}

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
      .select('id, job_type, state, safe_to_retry, attempt_count, phases, attempts, error_summary, updated_at')
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
