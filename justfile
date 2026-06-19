set dotenv-load

default:
    @just --list

build:
    cargo build

release:
    # Build the SvelteKit SPA into static-dist/ (build.rs no longer bundles),
    # then compile the release binary which serves it.
    cd frontend && npm ci && npm run build
    cargo build --release

run:
    cargo run

run-debug:
    RUST_LOG=debug cargo run

test:
    cargo test --workspace

test-mocks:
    cargo test --features test_utils

# DB-dependent integration tests gated on `--cfg integration_tests`.
# Spins up the test postgres on port 5433 first. Requires one row in
# auth.users on the test DB (start the server against it once to seed).
#
# IMPORTANT: DATABASE_URL is pinned to the test container on port 5433
# so a stray DATABASE_URL in `.env` (which `set dotenv-load` at the top
# of this file would otherwise leak in) cannot point the tests at the
# real dev DB. The test pool helpers also refuse non-`oxicloud_test`
# URLs as defence in depth.
test-integration:
    bash tests/common/spawn-db.sh
    PGHOST=localhost PGPORT=5433 PGUSER=oxicloud_test PGPASSWORD=oxicloud_test \
      PGDATABASE=oxicloud_test \
      bash tests/common/init-test-schema.sh
    DATABASE_URL='postgres://oxicloud_test:oxicloud_test@localhost:5433/oxicloud_test' \
      RUSTFLAGS='--cfg integration_tests' \
      cargo test --workspace --tests
    bash tests/common/stop-db.sh

test-one name:
    cargo test {{name}}

fmt:
    cargo fmt --all

fmt-check:
    cargo fmt --all --check

lint:
    cargo clippy --all-features --all-targets -- -D warnings

check:
    cargo fmt --all
    cargo clippy --all-features --all-targets -- -D warnings


wasm-check:
    cd wasm/oxicloud-hash; cargo fmt --all
    cd wasm/oxicloud-hash; cargo clippy --all-features --release -- -D warnings

wasm-test:
    cd wasm/oxicloud-hash; cargo test --release

# Run the host plugin-runtime tests (compiles the Extism/wasmtime runtime).
test-plugins:
    cargo test --features plugins

# Rebuild the committed plugin .wasm fixtures from wasm/oxicloud-plugin-hello/.
# Requires the wasm32 target (devenv provides it; else `rustup target add
# wasm32-unknown-unknown`). Commit the regenerated files; CI fails on drift.
plugin-build:
    bash scripts/build-plugin-hello.sh

# Build the example plugin and bundle plugin.toml + .wasm into an installable
# .zip at dist/oxicloud-plugin-hello.zip (upload via the admin Plugins tab).
plugin-example-zip:
    bash scripts/build-plugin-zip.sh

# fmt + clippy the example plugin crate (standalone workspace, wasm32 target).
plugin-check:
    cd wasm/oxicloud-plugin-hello; cargo fmt --all
    cd wasm/oxicloud-plugin-hello; cargo clippy --target wasm32-unknown-unknown --release -- -D warnings

# audit security (condition: cargo install cargo-audit)
audit:
    cargo audit

openapi:
    cargo run --bin generate-openapi

db:
    docker compose up -d postgres

db-down:
    docker compose down

# start OxiCloud with static assets in no-cache mode
front-dev:
    PROFILE=dev cargo run

# front: check all (linter, format, type, icons, translations...)
front-check: front-fmt front-lint front-type front-rules front-check-icons front-check-i18n frontend-check

# kept for compatibility
frontend-check: front-design

front-fmt:
    biome format static/

front-lint:
    biome lint static/

# test types (JSDOC), using typescript
front-type:
    tsc -p jsconfig.json --noEmit

# check CSS rules
front-rules:
    stylelint static/css/

front-check-icons:
    tools/check-icons.py --check-only

front-check-i18n:
    tools/check-missing-translations.py --check-only

# end-to-end Playwright tests
front-test:
    cd tests/e2e && npm test

# update images snapshots
front-test-update-snapshot:
    cd tests/e2e && npm test -- --update-snapshots=all

# Frontend design-system / a11y guardrails — pure Node, no extra deps.
# Single gate: WCAG contrast, heading order, locale completeness, dead tokens,
# brand-mark drift.
# (Also run `stylelint static/css/**/*.css`, `biome check`, `tsc -p jsconfig.json
#  --noEmit` once node_modules is installed — those need devDependencies.)
front-design:
    node scripts/check-contrast.mjs
    node scripts/check-headings.mjs
    node scripts/check-locales.mjs
    node scripts/check-dead-tokens.mjs
    node scripts/check-brand-drift.mjs


# Hurl API functional tests (starts postgres + server, tears down after)
api-test:
    bash tests/api/run.sh
    bash tests/webdav/run.sh

# ---------------------------------------------------------------------------
# New SvelteKit frontend (frontend/). The original vanilla frontend (static/)
# and its `front-*` recipes remain until the Phase 5 cutover; these `fe-*`
# recipes drive the rewrite in the meantime.
# ---------------------------------------------------------------------------

# install frontend dependencies
fe-install:
    cd frontend && npm ci

# Vite dev server only (HMR) — backend must already be running on :8086
fe-dev:
    cd frontend && npm run dev

# build the SPA (Phase 0: -> frontend/build; Phase 5: -> static-dist)
fe-build:
    cd frontend && npm run build

# svelte-check + eslint + stylelint + prettier
fe-check:
    cd frontend && npm run check

# Vitest unit/component tests
fe-test:
    cd frontend && npm run test:unit

# Run backend (API) and the Vite dev server together; one Ctrl-C stops both.
dev:
    #!/usr/bin/env bash
    set -euo pipefail
    cargo run &
    backend=$!
    trap 'kill $backend 2>/dev/null' EXIT INT TERM
    cd frontend && npm run dev

# k6 load suite — full scenarios + regression diff vs baseline/load.json.
# Used by the nightly workflow and on demand. Release build for fair timings.
load:
    bash tests/load/run.sh

# k6 smoke — single happy-path iteration. PR-tier liveness check, no gate.
load-smoke:
    bash tests/load/smoke.sh

# Re-run the full suite, then bake the latest summary into baseline/load.json.
# The leading `-` lets `run.sh`'s regression-exit not abort the bake step;
# review the diff and commit deliberately:
#   chore(load): accept new baseline for <reason>
load-baseline:
    -bash tests/load/run.sh
    node tests/load/bake-baseline.mjs

# Standalone seeder (poking around in psql). Needs the test DB up:
#   just db
load-seed:
    cargo run --bin load-seed -- --depth 5 --fanout 4 --files-per-leaf 3
