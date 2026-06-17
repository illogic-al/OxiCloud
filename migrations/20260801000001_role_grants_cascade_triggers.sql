-- ════════════════════════════════════════════════════════════════════════════
-- Cleanup #2: cascade triggers for storage.role_grants
-- ════════════════════════════════════════════════════════════════════════════
-- The D-Prep migration created `storage.role_grants` but no cascade triggers.
-- Until now, role_grants stayed consistent because the application-layer
-- lifecycle hooks (`engine.revoke_all_for_resource` / `_subject`) wiped rows
-- on the canonical delete paths, AND the existing `trg_cleanup_grants_*`
-- triggers kept `storage.access_grants` clean as a defence-in-depth net.
--
-- The follow-up cleanup PR drops `access_grants` (and its triggers) entirely.
-- Without this migration that drop would leave `role_grants` without any
-- DB-level safety net — direct SQL, future codepaths that forget to call the
-- engine hooks, and any other bypass route could orphan rows whose subject
-- or resource has already been deleted.
--
-- This migration mirrors the four forward + one reverse triggers from
-- `20260520000000_rebac_access_grants.sql` and `20260612000001_share_grant_
-- reverse_cascade.sql`, retargeted at `storage.role_grants`. Same shape, same
-- AFTER-DELETE semantics, same idempotent CREATE OR REPLACE patterns.
--
-- During the transition window (this migration applied; `access_grants` not
-- yet dropped) both sets of triggers coexist — they target different tables
-- and don't conflict. Once `access_grants` is dropped, the old triggers and
-- their helper functions vanish in the same migration.

-- ── 1. Forward cascade: resource delete → cleanup role_grants ──────────────
-- Fires AFTER DELETE on storage.folders / storage.files; deletes every
-- role_grants row referencing that resource. TG_ARGV[0] discriminates which
-- resource_type the trigger is wired for.

CREATE OR REPLACE FUNCTION storage.cleanup_role_grants_on_resource_delete()
RETURNS TRIGGER AS $$
BEGIN
    DELETE FROM storage.role_grants
     WHERE resource_type = TG_ARGV[0]
       AND resource_id   = OLD.id;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cleanup_role_grants_folder ON storage.folders;
CREATE TRIGGER trg_cleanup_role_grants_folder
    AFTER DELETE ON storage.folders
    FOR EACH ROW
    EXECUTE FUNCTION storage.cleanup_role_grants_on_resource_delete('folder');

DROP TRIGGER IF EXISTS trg_cleanup_role_grants_file ON storage.files;
CREATE TRIGGER trg_cleanup_role_grants_file
    AFTER DELETE ON storage.files
    FOR EACH ROW
    EXECUTE FUNCTION storage.cleanup_role_grants_on_resource_delete('file');


-- ── 2. Forward cascade: subject delete → cleanup role_grants ───────────────
-- Fires AFTER DELETE on auth.users / storage.shares; deletes every
-- role_grants row referencing that subject. Groups are NOT wired here —
-- `subject_group_service::delete()` performs that cascade transactionally
-- in application code, mirroring the historical access_grants behaviour.

CREATE OR REPLACE FUNCTION storage.cleanup_role_grants_on_subject_delete()
RETURNS TRIGGER AS $$
BEGIN
    DELETE FROM storage.role_grants
     WHERE subject_type = TG_ARGV[0]
       AND subject_id   = OLD.id;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cleanup_role_grants_user ON auth.users;
CREATE TRIGGER trg_cleanup_role_grants_user
    AFTER DELETE ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION storage.cleanup_role_grants_on_subject_delete('user');

DROP TRIGGER IF EXISTS trg_cleanup_role_grants_token ON storage.shares;
CREATE TRIGGER trg_cleanup_role_grants_token
    AFTER DELETE ON storage.shares
    FOR EACH ROW
    EXECUTE FUNCTION storage.cleanup_role_grants_on_subject_delete('token');


-- ── 3. Reverse cascade: last-token-grant delete → cleanup storage.shares ───
-- A caller hitting DELETE /api/grants/{id} on a token's role grant would
-- otherwise leave the storage.shares row stranded — the token still
-- resolves to "no access" (cascade query finds no rows), but the metadata
-- row accumulates forever.
--
-- With role_grants the UNIQUE (subject, resource) constraint guarantees a
-- token has at most ONE role grant per resource, so "the last grant for a
-- token" collapses to "the only grant for that token". The NOT EXISTS
-- guard still works correctly — it just always evaluates the same way for
-- token subjects.
--
-- The DELETE on storage.shares is a no-op when the share row is already
-- gone (the forward cascade `trg_cleanup_role_grants_token` is in flight
-- and already removed it). Idempotent in both directions.

CREATE OR REPLACE FUNCTION storage.cleanup_share_on_last_role_grant_delete()
RETURNS trigger AS $$
BEGIN
    IF OLD.subject_type = 'token' THEN
        DELETE FROM storage.shares s
         WHERE s.id = OLD.subject_id
           AND NOT EXISTS (
               SELECT 1 FROM storage.role_grants rg
                WHERE rg.subject_type = 'token'
                  AND rg.subject_id   = OLD.subject_id
           );
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cleanup_share_on_role_grant_delete ON storage.role_grants;
CREATE TRIGGER trg_cleanup_share_on_role_grant_delete
    AFTER DELETE ON storage.role_grants
    FOR EACH ROW
    EXECUTE FUNCTION storage.cleanup_share_on_last_role_grant_delete();

COMMENT ON FUNCTION storage.cleanup_share_on_last_role_grant_delete() IS
    'Reverse cascade: deletes storage.shares row when its last token role grant is removed. Pairs with trg_cleanup_role_grants_token (forward direction).';
