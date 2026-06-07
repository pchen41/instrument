// Builds the worker's per-phase executor: a job-type dispatcher over the two real
// workloads — the Task 5B/5C investigation (viability jobs) and the Task 6
// PR-review analysis (github_pr_review_analysis jobs). Each underlying executor
// already no-ops for jobs that aren't its kind, but dispatching by job_type keeps
// the wiring explicit and avoids constructing both call paths per phase. Shared by
// the scheduled tick (job-worker-tick) and the console inline tick (console-actions)
// so a retried PR-review job is processed the same way on either path.
import { makeInvestigationExecutor, type PhaseExecutor } from '../../lib/agent.ts';
import { makePrReviewExecutor } from '../../lib/agent-pr.ts';
import { makeScanExecutor } from '../../lib/agent-scan.ts';
import { makePrGenExecutor } from '../../lib/agent-prgen.ts';
import { makeDdAlertExecutor } from '../../lib/agent-ddalert.ts';
import { makeRecGenExecutor } from '../../lib/agent-recgen.ts';
import { createGateway, createScriptedToolHost, createWorkStore } from './agent-runtime.ts';
import { createAgentInvoker, createModelCallStore } from './model-call-store.ts';
import { createPrMcp, createPrReviewStore } from './pr-review-store.ts';
import { createScanMcp, createScanStore } from './scan-store.ts';
import { createPrGenMcp, createPrGenStore } from './prgen-store.ts';
import { createDdAlertMcp, createDdAlertStore } from './ddalert-store.ts';
import { createRecGenMcp, createRecGenStore } from './recgen-store.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

export function buildExecutePhase(admin: Admin): PhaseExecutor {
  const investigation = makeInvestigationExecutor({
    gateway: createGateway(),
    tools: createScriptedToolHost(),
    store: createWorkStore(admin),
  });
  const prReview = makePrReviewExecutor({
    gateway: createAgentInvoker(),
    modelStore: createModelCallStore(admin),
    mcp: createPrMcp(admin),
    store: createPrReviewStore(admin),
  });
  const scan = makeScanExecutor({
    gateway: createAgentInvoker(),
    modelStore: createModelCallStore(admin),
    mcp: createScanMcp(admin),
    store: createScanStore(admin),
  });
  const prGen = makePrGenExecutor({
    gateway: createAgentInvoker(),
    modelStore: createModelCallStore(admin),
    mcp: createPrGenMcp(admin),
    store: createPrGenStore(admin),
  });
  const ddAlert = makeDdAlertExecutor({
    mcp: createDdAlertMcp(admin),
    store: createDdAlertStore(admin),
  });
  const recGen = makeRecGenExecutor({
    gateway: createAgentInvoker(),
    modelStore: createModelCallStore(admin),
    mcp: createRecGenMcp(admin),
    store: createRecGenStore(admin),
  });
  return (ctx) => {
    if (ctx.job.job_type === 'github_pr_review_analysis') return prReview(ctx);
    if (ctx.job.job_type === 'proactive_scan') return scan(ctx);
    if (ctx.job.job_type === 'recommendation_pr_generation') return prGen(ctx);
    if (ctx.job.job_type === 'datadog_alert_generation') return ddAlert(ctx);
    if (ctx.job.job_type === 'recommendation_generation') return recGen(ctx);
    return investigation(ctx);
  };
}
