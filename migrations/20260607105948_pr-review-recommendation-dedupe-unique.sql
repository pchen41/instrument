-- Task 6 (slice 2 review fix L2): make the recommendation dedupe fingerprint a
-- DB-enforced uniqueness boundary per workspace.
--
-- upsertRecommendation does select-then-insert with an isUniqueViolation fallback,
-- but the existing recommendations_dedupe_idx is a non-unique index, so two
-- concurrent PR-review jobs for the same PR could both SELECT-miss then INSERT →
-- two recommendations for one PR. A unique index makes the racing insert raise
-- 23505, which the upsert already resolves to the existing row. dedupe_fingerprint
-- is the cross-scan dedupe key for every recommendation category, so one row per
-- (workspace_id, dedupe_fingerprint) is the intended invariant.
--
-- Data verified free of duplicate (workspace_id, dedupe_fingerprint) before this
-- migration. Replaces the non-unique index with a unique one.

drop index if exists recommendations_dedupe_idx;

create unique index if not exists recommendations_dedupe_uniq
  on recommendations (workspace_id, dedupe_fingerprint);
