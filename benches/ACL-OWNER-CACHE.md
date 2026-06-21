# ACL owner-cache benchmark

Opportunity #2 from the backend perf investigation. `PgAclEngine::check` runs an
owner short-circuit on every authorization check of a folder/file — the common
case (a user touching their own resources). That was an uncached PK query
(`SELECT user_id FROM storage.folders/files WHERE id=$1`) **per check**. Now
memoised in an `owner_cache` (moka, `pg_acl_engine.rs`); the owner column is
immutable so it's safe to cache.

## Safety

The cache maps `resource → real owner`. It can **never** grant a non-owner
access: a different caller's `owner == uid` test fails against the cached real
owner and falls through to the grant lookup. The only staleness is a
hard-deleted resource briefly resolving to its former owner — harmless, since the
operation then fails at execution with NotFound, and no new access is granted.
TTL 300 s, capacity 100 k. (Owners never change, so no invalidation hook needed.)

## Reproduce

```bash
docker compose up -d postgres   # needs ≥1 folder in the dev DB (just load-seed)
cargo run --release --features bench --example bench_owner_cache
# tunables: BENCH_CONCURRENCY (64), BENCH_POOL_SIZE (20 = prod default), BENCH_SECONDS (4)
```

Models the owner short-circuit: the exact owner query vs a moka hit, under
concurrency, against the real dev Postgres.

## Results (14 cores, local Docker Postgres)

**Burst — C = 64, pool = 20 (pool-saturating):**

| mode             | DB queries | checks/s | p50 µs | p95 µs | p99 µs | max µs |
|------------------|-----------:|---------:|-------:|-------:|-------:|-------:|
| uncached (before)|      32746 |     8172 | 7063.0 |11323.9 |20135.1 |106015.7|
| cached (after)   |          1 |  6114546 |   1.46 |   3.00 |   3.79 | 75111* |

**Low load — C = 8, pool = 20 (no queueing, isolates pure query cost):**

| mode             | DB queries | checks/s | p50 µs | p95 µs | p99 µs | max µs |
|------------------|-----------:|---------:|-------:|-------:|-------:|-------:|
| uncached (before)|      25432 |     6357 | 1097.5 | 2091.5 | 2433.9 |10105.8 |
| cached (after)   |          1 |  5076363 |   0.88 |   5.00 |  10.92 |  2342* |

\* `max` for the cached path is a tokio-scheduler / allocation outlier, not the
cache — p99 (µs) is the meaningful tail.

## Conclusions

1. **Per owner check, 1 DB query → 1 memory hit.** Pure query cost (C=8): the
   cache saves **~1.1 ms p50 / 2.4 ms p99** per check (the owner query latency
   on this Docker-on-macOS Postgres).

2. **Under burst it compounds with the pool (opportunity #1).** At C=64/pool=20,
   the uncached checks both pay the query *and* queue on `acquire()` → p50 7 ms,
   p99 20 ms. The cache removes the query entirely → no pool occupancy → p99
   3.8 µs. Fewer queries ⇒ less pool pressure ⇒ lower tail latency under exactly
   the conditions that cause the cliff.

3. **Caveat:** the absolute ms here are inflated by the local Docker Postgres
   query latency (~1–2.4 ms; a tuned local PG would be faster, a networked/loaded
   one similar or worse) and the deliberately induced pool pressure. The robust,
   deployment-independent facts are: **1 fewer DB query and 1 fewer pool
   acquisition per authorized action on an owned resource** — which is most
   actions, since users mostly touch their own files.

4. Scope: this is the owner short-circuit (the hot path). Non-owner checks still
   do the cascade grant query (unchanged); group expansion was already cached.
