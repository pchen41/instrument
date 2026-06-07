-- Task 5B: atomic backstop for the investigation worker's idempotent persistence.
--
-- The worker dedupes model calls / evidence with a check-then-insert guard
-- (hasModelCall / hasEvidence). That guard is not atomic under a concurrent lease
-- reclaim, so these unique indexes make once-only a DB guarantee: a racing insert
-- raises 23505, which the store treats as an idempotent no-op.
--
-- Idempotency keys (the first-slice investigation contract = one call/evidence per
-- key per job): ai_model_calls = (job_id, purpose); evidence_items =
-- (collected_by_job_id, subject_key). A future workflow that needs multiple calls
-- with the same purpose per job must extend the key and this index together.
-- Partial (NOT NULL) so rows that don't use this key shape are unconstrained.

create unique index if not exists ai_model_calls_job_purpose_uniq
  on ai_model_calls (job_id, purpose)
  where job_id is not null and purpose is not null;

create unique index if not exists evidence_items_job_subject_key_uniq
  on evidence_items (collected_by_job_id, subject_key)
  where collected_by_job_id is not null and subject_key is not null;
