# Blob-manifest read — halve the manifest round-trips

`DedupService::read_blob_bytes` (the full-blob read used by thumbnail generation,
EXIF extraction, content indexing, etc.) used to read the **same**
`storage.chunk_manifests` PK row **twice**:

- `blob_size(hash)` → `SELECT total_size …` (for the buffer pre-allocation), then
- `read_blob_stream(hash)` → `SELECT chunk_hashes …` (to stream the chunks).

On the thumbnail cold path that's **2N manifest queries** for an N-image gallery
load. The change folds both into one query and shares the chunk-stream builder:

```sql
SELECT chunk_hashes, total_size FROM storage.chunk_manifests WHERE file_hash = $1
```

(`dedup_service.rs` — `read_blob_bytes` + the extracted `stream_chunks` helper.)
The legacy (no-manifest) path is unchanged.

## Reproduce

```bash
cargo run --release --features bench --example bench_blob_manifest
```

Needs the dev Postgres up (reads `DATABASE_URL` from `.env`). The bench isolates
exactly what changed — the manifest lookup(s) per blob read, not the unchanged
chunk streaming — running OLD (2 queries/op) vs NEW (1 query/op) against the real
pool, at low contention (raw per-op cost) and high contention (concurrency > pool,
where holding a connection ~2× longer inflates the tail).

## Results (pool=20, 4 s/run, 64-chunk manifest)

| contention | mode | ops/s | p50 ms | p95 ms | p99 ms |
|---|---|---:|---:|---:|---:|
| conc 4 (no pool pressure) | OLD (2q) | 4 646 | 0.850 | 1.028 | 1.213 |
| | **NEW (1q)** | **8 931** | **0.442** | **0.546** | **0.644** |
| conc 64 (> pool 20) | OLD (2q) | 7 490 | 8.538 | 9.201 | 10.117 |
| | **NEW (1q)** | **14 330** | **4.396** | **5.229** | **5.869** |

- **~1.9× throughput** on the manifest-read step, **p50 and p99 roughly halved**.
- Under pool pressure the absolute latency saved is larger (p50 8.5 → 4.4 ms),
  because each OLD read occupies a connection for two round-trips instead of one —
  exactly the tail-latency-under-contention win this targeted.

The end-to-end gallery-load impact is smaller than 1.9× (chunk reads and decode
dominate the full `read_blob_bytes`), but this removes one DB round-trip from
*every* full-blob read, which is the part that queues under load.
