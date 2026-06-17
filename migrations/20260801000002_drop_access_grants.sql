-- ════════════════════════════════════════════════════════════════════════════
-- Cleanup #3: drop storage.access_grants (and everything attached to it)
-- ════════════════════════════════════════════════════════════════════════════
-- The final step of the role-keyed ReBAC cleanup. By the time this migration
-- runs:
--
--   * Every read path goes through `storage.role_grants` (cleanup #1 / #2).
--   * The engine no longer has a `grant()` method; `set_role()` /
--     `clear_role()` are the only writes.
--   * The HTTP surface (`POST /api/grants`, `PUT /api/grants/role`) only
--     accepts role-keyed shapes.
--   * `share_service`, `subject_group_service`, `auth_application_service`,
--     `share_pg_repository`, and `integration_test_support` all read
--     `role_grants` exclusively.
--   * `storage.role_grants` has its own cascade triggers
--     (`trg_cleanup_role_grants_*`) and reverse-cascade
--     (`trg_cleanup_share_on_role_grant_delete`), added in cleanup #2.
--
-- So `access_grants` is fully unreferenced — we can drop it together with
-- the helper triggers + functions defined in
-- `20260520000000_rebac_access_grants.sql` and
-- `20260612000001_share_grant_reverse_cascade.sql`.
--
-- Roll-back posture: this is destructive. There is no down migration. The
-- D-Prep backfill is one-way (role-keyed rows are derived from
-- permission-keyed clusters; the reverse reconstruction would need a fixed
-- bundle mapping that may have shifted between releases). Recovering
-- requires restoring from a backup taken before this migration runs.

-- ── 1. Drop the access_grants triggers FROM their source tables ────────────
-- These triggers live on storage.folders / storage.files / auth.users /
-- storage.shares. Dropping access_grants doesn't implicitly remove them
-- (the trigger row points at the source table; the body references the
-- target table, and that body is what breaks once access_grants is gone).
-- Drop them explicitly so subsequent DELETEs on those source tables don't
-- error out.

DROP TRIGGER IF EXISTS trg_cleanup_grants_folder ON storage.folders;
DROP TRIGGER IF EXISTS trg_cleanup_grants_file   ON storage.files;
DROP TRIGGER IF EXISTS trg_cleanup_grants_user   ON auth.users;
DROP TRIGGER IF EXISTS trg_cleanup_grants_token  ON storage.shares;

-- The reverse-cascade trigger is ON access_grants and goes away with the
-- table — but the IF EXISTS makes this safe regardless of drop order.
DROP TRIGGER IF EXISTS trg_cleanup_share_on_grant_delete ON storage.access_grants;


-- ── 2. Drop the trigger helper functions ────────────────────────────────────
-- No other code references these — the `cleanup_role_grants_*` equivalents
-- defined in cleanup #2 carry the same behaviour against role_grants.

DROP FUNCTION IF EXISTS storage.cleanup_grants_on_resource_delete();
DROP FUNCTION IF EXISTS storage.cleanup_grants_on_subject_delete();
DROP FUNCTION IF EXISTS storage.cleanup_share_on_last_token_grant_delete();


-- ── 3. Drop the table ──────────────────────────────────────────────────────
-- CASCADE removes any remaining dependent objects (indexes, comments, and
-- the reverse-cascade trigger if it survived step 1). With every Rust code
-- path already routed through role_grants, nothing in the application
-- layer will notice.

DROP TABLE IF EXISTS storage.access_grants CASCADE;
