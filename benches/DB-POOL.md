# DB connection-pool tail-latency benchmark

Measures how `OXICLOUD_DB_MAX_CONNECTIONS` (default 20, `config.rs`) affects
throughput and tail latency (p95/p99) under concurrent load. Isolates the pool
layer from HTTP/auth: a real `sqlx` Postgres pool of size P driven by C
concurrent workers each looping `SELECT pg_sleep(query_ms)`. Measured latency =
**acquire-wait + query** — the pool-queue effect. `pg_sleep` models query
*duration* (connection occupancy); real listing/auth queries take a few ms each.

## Reproduce

```bash
docker compose up -d postgres            # needs the dev Postgres
cargo run --release --features bench --example bench_db_pool
# tunables: BENCH_CONCURRENCY=96 BENCH_QUERY_MS=3 BENCH_SECONDS=4 BENCH_POOL_SIZES=10,20,40,70
```

## Results (14 cores, local Postgres `max_connections=100`, pg_sleep 3 ms)

**Burst — concurrency C = 96 in-flight requests:**

| pool | req/s | p50 ms | p95 ms | p99 ms | max ms |
|-----:|------:|-------:|-------:|-------:|-------:|
|   10 |  1553 |  61.1  |  69.2  |  71.9  |  76.6  |
|   20 |  3076 |  30.9  |  35.1  |  41.8  |  58.3  |
|   40 |  5745 |  16.1  |  20.8  |  25.0  |  32.3  |
|   70 |  9078 |   9.9  |  15.1  |  18.8  |  27.9  |

**Bigger burst — C = 192:**

| pool | req/s | p50 ms | p95 ms | p99 ms | max ms |
|-----:|------:|-------:|-------:|-------:|-------:|
|   10 |  1550 | 123.2  | 130.1  | 138.2  | 143.5  |
|   20 |  3073 |  61.9  |  69.3  |  73.2  |  76.2  |
|   40 |  5796 |  32.9  |  36.9  |  38.1  |  40.0  |
|   70 |  9338 |  20.6  |  24.0  |  25.1  |  27.8  |

**Low load — C = 16 (≤ pool for 20/40/70):**

| pool | req/s | p50 ms | p95 ms | p99 ms | max ms |
|-----:|------:|-------:|-------:|-------:|-------:|
|   10 |  1569 |  10.2  |  13.7  |  14.6  |  16.2  |
|   20 |  2555 |   6.0  |   7.9  |  13.4  |  42.8  |
|   40 |  2484 |   6.1  |   7.9  |  14.8  |  30.9  |
|   70 |  2573 |   6.1  |   7.5  |  11.5  |  20.7  |

## Conclusions

1. **When in-flight DB queries exceed the pool, the pool is the bottleneck.**
   Throughput scales ~linearly with pool size; latency ≈ concurrency × query /
   pool. At C=96, raising 20→70 gave **3.0× throughput** (2875→9078 req/s) and
   **2.2× lower p99** (42→19 ms). At C=192: **3× throughput**, **2.9× lower p99**
   (73→25 ms). The bigger the burst, the steeper the cliff a small pool creates.

2. **But once pool ≥ actual concurrency, more pool does NOTHING.** At C=16,
   pool 20/40/70 are identical (~6 ms p50, ~2500 req/s). Sizing beyond your peak
   concurrent in-flight query count is wasted (and costs Postgres connections).

3. **The right value ≈ your peak concurrent in-flight DB-query count** — not "as
   big as possible". Find it from the existing `DbPoolMonitor` (warns at 90%
   utilization). If it warns, raise `OXICLOUD_DB_MAX_CONNECTIONS`; if it never
   warns, the default 20 is fine.

4. Bounds: total connections are capped by Postgres `max_connections` (100 here,
   shared with the maintenance pool + other clients), and pg_sleep models I/O
   wait — real queries also use Postgres CPU, so a pool ≫ DB cores can overload
   Postgres. Don't raise blindly.

5. The default 20 is a sensible default for a low-concurrency self-hosted
   deployment; it becomes a tail-latency bottleneck under bursts of >20
   simultaneous DB-bound requests (many sync clients, bulk ops, or one browser
   firing many parallel requests). Left as an env knob rather than changing the
   default, because the right value is deployment-specific.

(Note: an early C=96 run showed a one-off p99=98 ms at pool=20 that did not
reproduce — measurement noise, not a real effect.)
