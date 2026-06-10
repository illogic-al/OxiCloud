-- Asynchronous tree-ETag bumps: enqueue-only triggers + background flusher.
--
-- The statement-level triggers from `20260626000000_tree_etag_statement_triggers`
-- still updated ancestor folder rows inside the writer's own transaction,
-- locking them with `SELECT … ORDER BY id FOR UPDATE`. That lock conflicts
-- with the FOR KEY SHARE lock the FK RI check on files.folder_id takes on
-- the parent folder row at INSERT time — a shared-to-exclusive upgrade on
-- the same hot row. Two concurrent uploads into one folder form a mutual
-- cycle; PostgreSQL's deadlock detector (deadlock_timeout = 1 s) aborts one
-- victim per cycle. Measured on a real bulk upload: 363 deadlocks, 31 % of
-- uploads failed with HTTP 500, throughput collapsed from a demonstrated
-- ~185 files/s burst to ~1 resolved transaction per second.
--
-- The fix removes ALL folder-row locking from user-facing write paths:
--
--   * The four bump functions now only INSERT the affected lpath targets
--     into `storage.tree_etag_dirty` — a plain heap append with no unique
--     constraints, taking zero shared row locks. Parallel uploads now only
--     share FOR KEY SHARE locks on the parent folder (mutually compatible),
--     so N-way concurrent writes cannot conflict, by construction.
--   * A single background task in the app (`TreeEtagFlushService`, on the
--     maintenance pool) drains the queue every ~500 ms and applies ONE
--     batched ancestor UPDATE with deterministic id-order locking.
--
-- Semantics preserved from 20260626000000 (see that migration's header):
--   * depth guard: bumps fired from inside another trigger's DML
--     (FK cascades, the lpath cascade rewrite) are skipped;
--   * UPDATE value filters: only DAV-observable column changes count
--     (the EXIF media_sort_date sync never bumps);
--   * file moves cover the OLD parent chain as well as the NEW one;
--   * folder events bump STRICT ancestors only (self-exclusion).
--
-- Semantic delta, decided deliberately: ancestor ETags become eventually
-- consistent (≤ ~1 flush interval after commit) instead of same-transaction.
-- No reader requires same-transaction freshness: collection ETags are only
-- compared across successive PROPFIND polls (seconds apart), and no mutation
-- response embeds a freshly bumped ANCESTOR etag (folder create/rename/move
-- responses return the row's OWN tree_modified_at, which bumps never touch).
-- The flusher orders its bump strictly after the writer's commit, so an ETag
-- can never change before the content that caused it is visible.

-- ── Dirty queue ──────────────────────────────────────────────────────
-- Each row is one "bump request", dual-keyed:
--   * `lpath`     — the target chain CAPTURED at mutation time. Covers
--                   chains whose folders are deleted or moved away by
--                   flush time (the old location's surviving ancestors
--                   still get their bump — unrecoverable from an id).
--   * `folder_id` — the same target folder's id, re-resolved to its
--                   CURRENT lpath at flush time. Covers the converse
--                   race: a folder MOVED inside the flush window has its
--                   whole subtree's lpaths rewritten, so the captured
--                   lpath no longer prefix-matches it and the pending
--                   bump would otherwise be silently lost (a sync client
--                   would never discover the change).
-- The flusher bumps the inclusive ancestor closure of the UNION of both.
-- File events target their parent folder; folder events target their
-- PARENT (subpath drops the last label), preserving self-exclusion —
-- one uniform inclusive queue semantic.
--
-- Append-only between flushes; the flusher deletes what it processes.
-- Logged (not UNLOGGED): a crash must not lose bumps. Duplicates are
-- expected and welcome; the flusher dedups. No FK on folder_id and no
-- indexes beyond the PK: enqueue must stay a pure append,
-- contention-free under any write concurrency.
CREATE TABLE IF NOT EXISTS storage.tree_etag_dirty (
    id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    lpath     ltree NOT NULL,
    folder_id UUID
);

-- Self-heal for databases that applied an earlier draft of THIS
-- migration (folder_id added after initial rollout of the queue).
ALTER TABLE storage.tree_etag_dirty ADD COLUMN IF NOT EXISTS folder_id UUID;

-- ── File side: INSERT / DELETE ───────────────────────────────────────
-- Both triggers alias their transition table to `changed_rows`; one body
-- serves both events. Reading fo.lpath is a plain MVCC read — no locks.
-- Root-level files (folder_id IS NULL) have no ancestors; a parent row
-- deleted in the same statement drops out of the JOIN (the folder-side
-- trigger of the outer statement covers the surviving ancestors).
CREATE OR REPLACE FUNCTION storage.bump_tree_from_files_stmt()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NULL;
    END IF;

    INSERT INTO storage.tree_etag_dirty (lpath, folder_id)
    SELECT DISTINCT fo.lpath, fo.id
      FROM (SELECT DISTINCT folder_id
              FROM changed_rows
             WHERE folder_id IS NOT NULL) c
      JOIN storage.folders fo ON fo.id = c.folder_id;

    RETURN NULL;
END;
$$;

-- ── File side: UPDATE ────────────────────────────────────────────────
-- Union of OLD and NEW parent chains so a move invalidates both the
-- source and the destination collection ETags. The value filter keeps
-- the 20260626000000 semantics: only DAV-observable changes enqueue
-- (PostgreSQL forbids `AFTER UPDATE OF <cols>` with transition tables,
-- so the filter lives here).
CREATE OR REPLACE FUNCTION storage.bump_tree_from_files_stmt_upd()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NULL;
    END IF;

    WITH changed AS (
        SELECT o.folder_id AS old_folder_id, n.folder_id AS new_folder_id
          FROM old_rows o
          JOIN new_rows n USING (id)
         WHERE (o.name, o.folder_id, o.blob_hash, o.size,
                o.mime_type, o.is_trashed, o.updated_at)
               IS DISTINCT FROM
               (n.name, n.folder_id, n.blob_hash, n.size,
                n.mime_type, n.is_trashed, n.updated_at)
    )
    INSERT INTO storage.tree_etag_dirty (lpath, folder_id)
    SELECT DISTINCT fo.lpath, fo.id
      FROM (SELECT old_folder_id AS folder_id
              FROM changed WHERE old_folder_id IS NOT NULL
            UNION
            SELECT new_folder_id
              FROM changed WHERE new_folder_id IS NOT NULL) c
      JOIN storage.folders fo ON fo.id = c.folder_id;

    RETURN NULL;
END;
$$;

-- ── Folder side: INSERT / DELETE ─────────────────────────────────────
-- Strict ancestors only: enqueue the PARENT's lpath (subpath drops the
-- last label), so the inclusive queue semantic covers parent + ancestors
-- but never the folder itself. Root folders (nlevel = 1) enqueue nothing.
-- The lpath value is captured HERE, at mutation time — by flush time the
-- row may be gone (purge) or rewritten (move), and the OLD chain would
-- be unrecoverable from a folder id.
CREATE OR REPLACE FUNCTION storage.bump_tree_from_folders_stmt()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NULL;
    END IF;

    INSERT INTO storage.tree_etag_dirty (lpath, folder_id)
    SELECT DISTINCT subpath(lpath, 0, nlevel(lpath) - 1), parent_id
      FROM changed_rows
     WHERE lpath IS NOT NULL
       AND nlevel(lpath) > 1;

    RETURN NULL;
END;
$$;

-- ── Folder side: UPDATE ──────────────────────────────────────────────
-- Union of OLD and NEW parent chains (a move bumps the chain it left and
-- the chain it joined), same value filter as 20260626000000: descendant
-- path/lpath rewrites by `trg_folders_cascade_path` change none of the
-- compared columns and additionally run at depth 2.
CREATE OR REPLACE FUNCTION storage.bump_tree_from_folders_stmt_upd()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NULL;
    END IF;

    WITH changed AS (
        SELECT o.lpath AS old_lpath, o.parent_id AS old_parent_id,
               n.lpath AS new_lpath, n.parent_id AS new_parent_id
          FROM old_rows o
          JOIN new_rows n USING (id)
         WHERE (o.name, o.parent_id, o.is_trashed, o.updated_at)
               IS DISTINCT FROM
               (n.name, n.parent_id, n.is_trashed, n.updated_at)
    )
    INSERT INTO storage.tree_etag_dirty (lpath, folder_id)
    SELECT DISTINCT subpath(c.lpath, 0, nlevel(c.lpath) - 1), c.parent_id
      FROM (SELECT old_lpath AS lpath, old_parent_id AS parent_id
              FROM changed WHERE old_lpath IS NOT NULL
            UNION
            SELECT new_lpath, new_parent_id
              FROM changed WHERE new_lpath IS NOT NULL) c
     WHERE nlevel(c.lpath) > 1;

    RETURN NULL;
END;
$$;

-- The six statement-level triggers from 20260626000000 keep their names
-- and wiring — they reference these functions by name, so replacing the
-- bodies above is the whole swap. `trg_folders_cascade_path` and the
-- BEFORE path triggers are untouched.
