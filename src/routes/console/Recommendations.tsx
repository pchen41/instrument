import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Segmented } from '../../components/console/Segmented';
import { ConfirmDialog, Drawer } from '../../components/console/overlays';
import { ErrorState, LoadingState, Toast, useTransientNotice } from '../../components/console/feedback';
import { useRecommendationsView } from '../../data/hooks';
import {
  getPrReviewRecord,
  type PrReviewComment,
  type PullRequestMeta,
  type RecommendationCard,
  type RecommendationDetail,
} from '../../data/reads';
import { runDeferredAction, type DeferredAction } from '../../data/deferred';
import { approveAndGenerate, setRecommendationState } from '../../data/actions';
import type { RecommendationStep } from '../../lib/schemas';

// Card glyph + label driven by the recommendation's category so it reads
// consistently (every Alert rec shows the same icon, etc.).
const KIND: Record<RecommendationCard['category'], { icon: string; label: string }> = {
  alert: { icon: 'bell', label: 'Alert' },
  instrumentation: { icon: 'levels', label: 'Instrumentation' },
  pr_review: { icon: 'pr', label: 'PR review' },
};

const ARCH_BADGE: Record<string, { order: number; icon: string; label: string }> = {
  accepted: { order: 0, icon: 'check-circle', label: 'Accepted' },
  dismissed: { order: 1, icon: 'close', label: 'Dismissed' },
  outdated: { order: 2, icon: 'clock', label: 'Outdated' },
};

type DrawerState =
  | { kind: 'pr' | 'monitor' | 'change'; rec: RecommendationCard; step: RecommendationStep }
  | { kind: 'review'; rec: RecommendationCard };

/**
 * Recommendations section. Server-backed: the Open / Archive split is the
 * recommendation's durable `state`, and each step renders from durable
 * `steps` JSON (locked / ready / done, with the generated PR or draft Datadog
 * monitor visible and linkable). The lifecycle mutations (dismiss, generate,
 * apply, mark merged) are rendered but their persistence ships with the Task 5A
 * action endpoints — they surface a notice rather than a silent no-op.
 */
export function Recommendations() {
  const [scope, setScope] = useState<'active' | 'archive'>('active');
  const view = useRecommendationsView(scope);
  const notice = useTransientNotice();
  const fire = useCallback((a: DeferredAction) => notice.show(runDeferredAction(a).message), [notice]);
  const changeState = useCallback(
    async (recommendationId: string, state: 'dismissed' | 'active') => {
      const res = await setRecommendationState(recommendationId, state);
      if (res.ok) await view.refetch();
      else notice.show(res.error ?? 'The recommendation could not be updated.');
    },
    [view, notice],
  );
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  // Explicit-approval confirm for code_pr generation (Task 8).
  const [gen, setGen] = useState<{ rec: RecommendationCard; step: RecommendationStep } | null>(null);
  const [submittingKey, setSubmittingKey] = useState<string | null>(null);
  const runGenerate = useCallback(
    async (rec: RecommendationCard, step: RecommendationStep) => {
      const key = `${rec.id}:${step.key}`;
      setSubmittingKey(key);
      try {
        const res = await approveAndGenerate({
          targetType: 'recommendation',
          targetId: rec.id,
          targetStepKey: step.key,
          actionType: 'generate_pr',
          approvalSummary: `Generate an instrumentation PR for "${rec.title}".`,
          payload: { recommendation_id: rec.id, step_key: step.key, action: 'generate_pr' },
        });
        if (res.ok) {
          notice.show('Generating the pull request…');
          await view.refetch();
        } else {
          notice.show(res.error ?? 'PR generation could not be started.');
        }
      } finally {
        setSubmittingKey(null);
      }
    },
    [notice, view],
  );

  const recs = view.data ?? [];

  return (
    <div className="content narrow">
      <div className="page-head">
        <div>
          <h1>Recommendations</h1>
          <div className="sub">Preventative fixes Instrument found by reading the codebase and signals.</div>
        </div>
        <div style={{ marginLeft: 'auto' }}>
          <Segmented
            ariaLabel="Recommendation filter"
            value={scope}
            onChange={setScope}
            options={[
              { id: 'active', label: 'Open', icon: 'lightbulb' },
              { id: 'archive', label: 'Archive', icon: 'archive' },
            ]}
          />
        </div>
      </div>

      {view.loading ? (
        <LoadingState label="Loading recommendations…" />
      ) : view.error ? (
        <ErrorState message="Recommendations could not be loaded." onRetry={view.refetch} />
      ) : recs.length === 0 ? (
        <EmptyRecs scope={scope} />
      ) : scope === 'active' ? (
        <div className="rec-grid">
          {recs.map((rec) => (
            <OpenCard
              key={rec.id}
              rec={rec}
              onOpen={setDrawer}
              onFire={fire}
              onGenerate={(r, s) => setGen({ rec: r, step: s })}
              onDismiss={() => changeState(rec.id, 'dismissed')}
              submittingKey={submittingKey}
            />
          ))}
        </div>
      ) : (
        <div className="rec-grid">
          {[...recs]
            .sort((a, b) => (ARCH_BADGE[a.state]?.order ?? 9) - (ARCH_BADGE[b.state]?.order ?? 9))
            .map((rec) => (
              <ArchivedCard key={rec.id} rec={rec} onRestore={() => changeState(rec.id, 'active')} />
            ))}
        </div>
      )}

      {drawer?.kind === 'review' && (
        <ReviewDrawer recommendationId={drawer.rec.id} onClose={() => setDrawer(null)} />
      )}
      {drawer && drawer.kind !== 'review' && (
        <StepArtifactDrawer state={drawer} onClose={() => setDrawer(null)} onFire={fire} />
      )}

      {gen && (
        <ConfirmDialog
          icon="pr"
          title="Generate this pull request?"
          confirmLabel="Approve & generate"
          confirmIcon="pr"
          onConfirm={() => {
            const g = gen;
            setGen(null);
            void runGenerate(g.rec, g.step);
          }}
          onCancel={() => setGen(null)}
          body={
            <span>
              Instrument opens a branch, commits the instrumentation change, and opens a pull request on
              GitHub for your review. Nothing is merged automatically.
            </span>
          }
        />
      )}

      {notice.notice && <Toast key={notice.key} message={notice.notice} onDone={notice.clear} />}
    </div>
  );
}

function EmptyRecs({ scope }: { scope: 'active' | 'archive' }) {
  return (
    <div className="empty">
      <div className="ei">
        <Icon name={scope === 'active' ? 'check-circle' : 'archive'} />
      </div>
      <h3>{scope === 'active' ? 'All caught up' : 'Nothing archived yet'}</h3>
      <p>
        {scope === 'active'
          ? 'No open recommendations right now. Instrument keeps reading the codebase and signals for gaps worth hardening.'
          : 'Recommendations you complete, dismiss, or that go stale are kept here.'}
      </p>
    </div>
  );
}

function OpenCard({
  rec,
  onOpen,
  onFire,
  onGenerate,
  onDismiss,
  submittingKey,
}: {
  rec: RecommendationCard;
  onOpen: (d: DrawerState) => void;
  onFire: (a: DeferredAction) => void;
  onGenerate: (rec: RecommendationCard, step: RecommendationStep) => void;
  onDismiss: () => Promise<void>;
  submittingKey: string | null;
}) {
  const kind = KIND[rec.category];
  const steps = [...(rec.steps ?? [])].sort((a, b) => a.order - b.order);
  const [dismissing, setDismissing] = useState(false);
  return (
    <div className="card rec">
      <div className="rec-ic">
        <Icon name={kind.icon} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="rhead">
          <span className="tag tag-kind">{kind.label}</span>
        </div>
        <h3>{rec.title}</h3>
        <p className="rdesc">{rec.rationale}</p>
        <ol className="rec-steps">
          {steps.map((step) => (
            <li
              key={step.key}
              className={'rec-step' + (step.state === 'locked' ? ' locked' : '') + (steps.length === 1 ? ' single' : '')}
            >
              {steps.length > 1 && <span className="rs-num">{step.order + 1}</span>}
              <Icon name={stepIcon(step)} className="rs-ic" />
              <span className="rs-label">{step.label}</span>
              <span className="rs-action">
                <StepAction
                  rec={rec}
                  step={step}
                  onOpen={onOpen}
                  onFire={onFire}
                  onGenerate={onGenerate}
                  submittingKey={submittingKey}
                />
              </span>
            </li>
          ))}
        </ol>
        <div className="rec-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={dismissing}
            onClick={async () => {
              setDismissing(true);
              try {
                await onDismiss();
              } finally {
                setDismissing(false);
              }
            }}
          >
            {dismissing ? (
              <>
                <span className="btn-spin" />
                Dismissing…
              </>
            ) : (
              'Dismiss'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function ArchivedCard({ rec, onRestore }: { rec: RecommendationCard; onRestore: () => Promise<void> }) {
  const kind = KIND[rec.category];
  const badge = ARCH_BADGE[rec.state];
  const [restoring, setRestoring] = useState(false);
  return (
    <div className={'card rec rec-closed ' + rec.state}>
      <div className="rec-ic">
        <Icon name={kind.icon} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="rhead">
          <span className="tag tag-kind">{kind.label}</span>
          {badge && (
            <span className={'arch-badge ' + rec.state}>
              <Icon name={badge.icon} />
              {badge.label}
            </span>
          )}
          {rec.state === 'dismissed' && (
            <button
              type="button"
              className="btn btn-ghost btn-sm arch-restore"
              style={{ marginLeft: 'auto' }}
              disabled={restoring}
              onClick={async () => {
                setRestoring(true);
                try {
                  await onRestore();
                } finally {
                  setRestoring(false);
                }
              }}
            >
              {restoring ? (
                <>
                  <span className="btn-spin" />
                  Restoring…
                </>
              ) : (
                <>
                  <Icon name="undo" />
                  Restore
                </>
              )}
            </button>
          )}
        </div>
        <h3>{rec.title}</h3>
        <p className="rdesc" style={{ marginBottom: 0 }}>
          {rec.state === 'outdated' && rec.outdated_reason ? rec.outdated_reason : rec.rationale}
        </p>
      </div>
    </div>
  );
}

// ---- Step actions -----------------------------------------------------------

function stepIcon(step: RecommendationStep): string {
  switch (step.kind) {
    case 'code_pr':
      return 'pr';
    case 'datadog_new_monitor':
      return 'bell';
    case 'datadog_monitor_change':
      return 'gauge';
    case 'dashboard_panel':
      return 'chart';
    case 'pr_review_record':
      return 'eye';
    default:
      return 'check';
  }
}

function doneLabel(step: RecommendationStep): string {
  if (step.kind === 'pr_review_record') return 'Comments posted';
  if (step.generated_pr?.number) return `PR #${step.generated_pr.number} merged`;
  if (step.kind === 'datadog_new_monitor') return 'Monitor created';
  if (step.kind === 'datadog_monitor_change') return 'Change applied';
  return 'Done';
}

function StepAction({
  rec,
  step,
  onOpen,
  onFire,
  onGenerate,
  submittingKey,
}: {
  rec: RecommendationCard;
  step: RecommendationStep;
  onOpen: (d: DrawerState) => void;
  onFire: (a: DeferredAction) => void;
  onGenerate: (rec: RecommendationCard, step: RecommendationStep) => void;
  submittingKey: string | null;
}) {
  // PR-review steps open straight to the posted comments (a read), regardless of
  // state — there is nothing to approve.
  if (step.kind === 'pr_review_record') {
    return (
      <button type="button" className="btn btn-primary btn-sm" onClick={() => onOpen({ kind: 'review', rec })}>
        <Icon name="eye" />
        View comments
      </button>
    );
  }

  if (step.state === 'locked') {
    return (
      <span className="rs-locked">
        <Icon name="branch" />
        <span>{step.waits_for ? `Unlocks when ${step.waits_for}` : 'Locked'}</span>
      </span>
    );
  }

  if (step.state === 'done') {
    return (
      <span className="rs-done">
        <Icon name="check-circle" />
        <span>{doneLabel(step)}</span>
      </span>
    );
  }

  if (step.state === 'failed') {
    return (
      <span className="rs-locked" style={{ color: 'var(--crit-ink)' }}>
        <Icon name="warning" />
        <span>Step failed</span>
      </span>
    );
  }

  if (step.state === 'skipped') {
    return (
      <span className="rs-locked">
        <Icon name="close" />
        <span>Skipped</span>
      </span>
    );
  }

  if (step.state === 'generating') {
    return (
      <button type="button" className="btn btn-secondary btn-sm gen-live" disabled>
        <span className="gen-dot pulse" />
        Generating
      </button>
    );
  }

  // ready / available: a generated artifact is viewable, or there is a draft to review.
  if (step.generated_pr) {
    const num = step.generated_pr.number;
    return (
      <button type="button" className="btn btn-primary btn-sm" onClick={() => onOpen({ kind: 'pr', rec, step })}>
        <Icon name="pr" />
        {num ? `View PR #${num}` : 'View PR'}
      </button>
    );
  }
  if (step.generated_monitor) {
    return (
      <button type="button" className="btn btn-primary btn-sm" onClick={() => onOpen({ kind: 'monitor', rec, step })}>
        <Icon name="bell" />
        View draft monitor
      </button>
    );
  }
  if (step.configuration_diff) {
    return (
      <button type="button" className="btn btn-primary btn-sm" onClick={() => onOpen({ kind: 'change', rec, step })}>
        <Icon name="sliders" />
        Review change
      </button>
    );
  }

  // No artifact yet. code_pr runs the real approval + external-write flow (Task 8);
  // Datadog monitor creation still routes through the deferred notice until its
  // generation executor ships (Task 9).
  if (step.kind === 'code_pr') {
    const isSubmitting = submittingKey === `${rec.id}:${step.key}`;
    return (
      <button
        type="button"
        className="btn btn-primary btn-sm"
        onClick={() => onGenerate(rec, step)}
        disabled={isSubmitting}
      >
        {isSubmitting ? (
          <>
            <span className="btn-spin" />
            Starting…
          </>
        ) : (
          <>
            <Icon name="pr" />
            Generate PR
          </>
        )}
      </button>
    );
  }
  return (
    <button type="button" className="btn btn-primary btn-sm" onClick={() => onFire('create_datadog_monitor')}>
      <Icon name="bell" />
      Create
    </button>
  );
}

// ---- Drawers ----------------------------------------------------------------

function StepArtifactDrawer({
  state,
  onClose,
  onFire,
}: {
  state: Exclude<DrawerState, { kind: 'review' }>;
  onClose: () => void;
  onFire: (a: DeferredAction) => void;
}) {
  const { step } = state;
  const [confirm, setConfirm] = useState<DeferredAction | null>(null);

  if (state.kind === 'pr' && step.generated_pr) {
    const pr = step.generated_pr;
    return (
      <Drawer
        icon="pr"
        title={pr.number ? `Pull request #${pr.number}` : 'Generated pull request'}
        onClose={onClose}
        footer={
          <>
            <button type="button" className="btn btn-ghost" style={{ marginRight: 'auto' }} onClick={onClose}>
              Close
            </button>
            {pr.url && (
              <a className="btn btn-secondary" href={pr.url} target="_blank" rel="noreferrer">
                <Icon name="external" />
                Open on GitHub
              </a>
            )}
            <button type="button" className="btn btn-primary" onClick={() => setConfirm('mark_pr_merged')}>
              <Icon name="branch" />
              Mark as merged
            </button>
          </>
        }
      >
        <h2 style={{ font: 'var(--h3)', margin: '0 0 6px' }}>{step.label}</h2>
        {pr.branch && (
          <>
            <div className="section-label">Branch</div>
            <div className="pr-file" style={{ marginBottom: '16px' }}>
              <Icon name="branch" />
              {pr.branch}
            </div>
          </>
        )}
        {pr.files && pr.files.length > 0 && (
          <>
            <div className="section-label">Files</div>
            <div style={{ marginBottom: '16px' }}>
              {pr.files.map((f) => (
                <div key={f} className="pr-file">
                  <Icon name="file-code" />
                  {f}
                </div>
              ))}
            </div>
          </>
        )}
        {pr.patch_excerpt && (
          <>
            <div className="section-label">Patch</div>
            <div className="diff">
              <span className="add">{pr.patch_excerpt}</span>
            </div>
          </>
        )}
        {confirm && (
          <ConfirmDialog
            icon="branch"
            title="Mark this PR as merged?"
            confirmLabel="Mark merged"
            onConfirm={() => {
              setConfirm(null);
              onFire('mark_pr_merged');
              onClose();
            }}
            onCancel={() => setConfirm(null)}
            body={<span>Instrument advances this recommendation once the pull request is merged on GitHub.</span>}
          />
        )}
      </Drawer>
    );
  }

  if (state.kind === 'monitor' && step.generated_monitor) {
    const m = step.generated_monitor;
    return (
      <Drawer
        icon="bell"
        title="Draft Datadog monitor"
        onClose={onClose}
        footer={
          <>
            <button type="button" className="btn btn-ghost" style={{ marginRight: 'auto' }} onClick={onClose}>
              Close
            </button>
            {m.url && (
              <a className="btn btn-secondary" href={m.url} target="_blank" rel="noreferrer">
                <Icon name="external" />
                Open in Datadog
              </a>
            )}
            <button type="button" className="btn btn-primary" onClick={() => onFire('create_datadog_monitor')}>
              <Icon name="check" />
              Publish monitor
            </button>
          </>
        }
      >
        <h2 style={{ font: 'var(--h3)', margin: '0 0 12px' }}>{step.label}</h2>
        <div className="monitor-card">
          <Icon name="bell" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="mc-name">{m.name ?? 'Draft monitor'}</div>
            <div className="mc-meta">
              {m.draft && <span className="draft-badge">Draft</span>}
              {m.monitor_id && <span className="mono" style={{ marginLeft: '8px' }}>#{m.monitor_id}</span>}
            </div>
          </div>
        </div>
        <p className="pr-note">
          A draft monitor has been created in Datadog for review. It does not notify anyone until you
          publish it.
        </p>
      </Drawer>
    );
  }

  if (state.kind === 'change' && step.configuration_diff) {
    const diff = step.configuration_diff;
    return (
      <Drawer
        icon="sliders"
        title="Configuration change"
        onClose={onClose}
        footer={
          <>
            <button type="button" className="btn btn-ghost" style={{ marginRight: 'auto' }} onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setConfirm('generate_monitor_change')}>
              <Icon name="check" />
              Apply change
            </button>
          </>
        }
      >
        <h2 style={{ font: 'var(--h3)', margin: '0 0 6px' }}>{step.label}</h2>
        {diff.monitor && <div className="section-label">Applies to {diff.monitor}</div>}
        <div className="chg">
          {(diff.rows ?? []).map((row, i) => (
            <div key={i} className="chg-row">
              <span className="chg-k">{row.k}</span>
              {row.from ? (
                <span className="chg-v">
                  <span className="chg-from">{row.from}</span>
                  <Icon name="arrow-right" />
                  <span className="chg-to">{row.to}</span>
                </span>
              ) : (
                <span className="chg-v">{row.v}</span>
              )}
            </div>
          ))}
        </div>
        {confirm && (
          <ConfirmDialog
            icon="sliders"
            title="Apply this change?"
            confirmLabel="Apply change"
            confirmIcon="check"
            onConfirm={() => {
              setConfirm(null);
              onFire('generate_monitor_change');
              onClose();
            }}
            onCancel={() => setConfirm(null)}
            body={<span>Instrument will apply this configuration change in Datadog. Nothing changes until you confirm.</span>}
          />
        )}
      </Drawer>
    );
  }

  return null;
}

/** PR-review drawer: loads the reviewed PR's metadata + posted comments lazily. */
function ReviewDrawer({ recommendationId, onClose }: { recommendationId: string; onClose: () => void }) {
  const [state, setState] = useState<{
    loading: boolean;
    error: boolean;
    recommendation?: RecommendationDetail;
    pullRequest?: PullRequestMeta | null;
    comments?: PrReviewComment[];
  }>({ loading: true, error: false });

  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await getPrReviewRecord(recommendationId);
      if (!live) return;
      if (res.error || !res.data) {
        setState({ loading: false, error: true });
      } else {
        setState({ loading: false, error: false, ...res.data });
      }
    })();
    return () => {
      live = false;
    };
  }, [recommendationId]);

  const pr = state.pullRequest;
  return (
    <Drawer
      icon="pr"
      title="Review comments"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" style={{ marginRight: 'auto' }} onClick={onClose}>
            Close
          </button>
          {pr?.html_url && (
            <a className="btn btn-primary" href={pr.html_url} target="_blank" rel="noreferrer">
              <Icon name="external" />
              Open PR on GitHub
            </a>
          )}
        </>
      }
    >
      {state.loading ? (
        <LoadingState label="Loading review…" />
      ) : state.error ? (
        <ErrorState message="The review record could not be loaded." />
      ) : (
        <>
          {pr && (
            <div className="rev-pr">
              <Icon name="pr" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="rev-pr-title">{pr.title}</div>
                <div className="rev-pr-meta">
                  #{pr.external_pr_number} · {pr.author_login ?? 'unknown'} ·{' '}
                  <span className="mono">{pr.head_branch}</span>
                </div>
              </div>
            </div>
          )}
          {state.recommendation?.rationale && <p className="rev-intro">{state.recommendation.rationale}</p>}
          <div className="section-label">{state.comments?.length ?? 0} comments on this PR</div>
          <div className="rev-comments">
            {(state.comments ?? []).map((c) => (
              <div key={c.id} className="rev-comment">
                <div className="rev-loc">
                  <Icon name="file-code" />
                  <span className="mono">
                    {c.file_path}:{c.line_number}
                  </span>
                </div>
                <p className="rev-text">{c.body}</p>
                {c.suggested_code && <div className="rev-code mono">{c.suggested_code}</div>}
              </div>
            ))}
          </div>
        </>
      )}
    </Drawer>
  );
}
