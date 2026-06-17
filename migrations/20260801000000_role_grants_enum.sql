-- ════════════════════════════════════════════════════════════════════════════
-- Cleanup #1: storage.role_grants.role — TEXT → storage.grant_role ENUM
-- ════════════════════════════════════════════════════════════════════════════
-- D-Prep shipped `role_grants.role` as TEXT + CHECK constraint. Promoting it
-- to a native PostgreSQL ENUM gives us three things at once:
--
--   1. Index-driven sort by role strength. The ENUM values are declared in
--      strength order — owner first, viewer last. `ORDER BY role ASC` then
--      yields the UX-mandated "strongest first" ordering (Owner → Editor →
--      Contributor → Commenter → Viewer) without a CASE expression. The
--      `idx_role_grants_subject` / `idx_role_grants_resource` indexes can be
--      extended (or composite-augmented) with the role column for index-only
--      ordered scans.
--
--   2. Type-level safety. The CHECK constraint goes away; invalid roles fail
--      at the column type, not at row insertion. One contract instead of two
--      (column type AND check constraint).
--
--   3. Cleaner query shape. Every listing query that used the strength CASE
--      becomes a plain `ORDER BY role` after this migration.
--
-- Trade-off accepted: PostgreSQL ENUMs allow ADD VALUE (with BEFORE / AFTER
-- positional anchors) and RENAME VALUE, but not DROP VALUE or arbitrary
-- reorder. The OxiCloud role roster is intentionally stable — new roles get
-- appended, none get reordered or removed. Confirmed with Ed.
--
-- This migration must run BEFORE the access_grants drop, since it's purely
-- about role_grants.role.

-- ── 1. Create the ENUM type ────────────────────────────────────────────────
-- Declaration order = sort order. Strongest first so `ORDER BY role ASC`
-- matches the UX requirement (max permission → least permission).

CREATE TYPE storage.grant_role AS ENUM (
    'owner',         -- ordinal 0, sorts first
    'editor',        -- ordinal 1
    'contributor',   -- ordinal 2
    'commenter',     -- ordinal 3
    'viewer'         -- ordinal 4, sorts last
);

COMMENT ON TYPE storage.grant_role IS
    'Role-keyed grant strength. Declaration order is sort order: ORDER BY '
    'role ASC yields owner → viewer (strongest → weakest), matching the '
    'share-dialog and shared-with-me UX. Adding a new role is ALTER TYPE '
    'ADD VALUE; renaming is ALTER TYPE RENAME VALUE. Dropping or reordering '
    'is not supported — adjust the roster only by append.';


-- ── 2. Drop the redundant CHECK constraint ─────────────────────────────────
-- The inline CHECK on role_grants.role was auto-named
-- `role_grants_role_check` by PostgreSQL. Drop it before the type swap —
-- the ENUM now enforces the same invariant at the column level.

ALTER TABLE storage.role_grants
    DROP CONSTRAINT IF EXISTS role_grants_role_check;


-- ── 3. Convert role TEXT → storage.grant_role ──────────────────────────────
-- USING cast: text values are guaranteed to be one of the five valid labels
-- (the dropped CHECK enforced this; the D-Prep backfill only produced these
-- five values). If a stray value slipped through, the cast errors out and
-- the migration aborts — preferable to silently coercing.

ALTER TABLE storage.role_grants
    ALTER COLUMN role TYPE storage.grant_role
        USING role::storage.grant_role;

COMMENT ON COLUMN storage.role_grants.role IS
    'One of owner / editor / contributor / commenter / viewer. Expanded to '
    'a Permission bundle by the in-code role_bundle() function at engine '
    'read time. Sort order matches declaration order in storage.grant_role.';
