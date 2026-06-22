# Blob download read-ahead benchmark

Measures the local backend's chunk read-ahead depth — the `buffered(N)`
read-ahead in `DedupService::stream_chunks` fed by
`BlobStorageBackend::read_prefetch()`. Reproduces the exact production reassembly
combinator (`stream::iter(hashes).map(get_blob_stream).buffered(N).try_flatten()`)
over a real `LocalBlobBackend` whose chunk files are scattered across the 256
hash-prefix dirs, then drains it and reports throughput. `N = 1` is the old
production default ("antes"); higher N is the change ("después").

## Reproduce

```bash
cargo run --release --features bench --example bench_blob_prefetch
# tunables: BENCH_FILE_MB=192 BENCH_CHUNK_KB=256 BENCH_PREFETCH=1,2,4,8,16
#   BENCH_THROTTLE_MBPS=0,300,100 BENCH_REPS=5 BENCH_COLD=1
```

## Results (4-core box, SSD-class storage, 192 MiB in 768×256 KiB chunks)

Median MB/s over 5 reps; `vs N=1` is the read-ahead gain over the old default.

| scenario                | N=1 |  N=2 |  N=4 |  N=8 | N=16 |
|-------------------------|----:|-----:|-----:|-----:|-----:|
| warm / unthrottled      |1306 | **1460** |1394 |1357 |1248 |
| cold / unthrottled      | 456 | **489** | 469 | 478 | 473 |
| warm / throttled@300MB/s| 167 | 166 | 166 | 166 | 166 |
| cold / throttled@300MB/s| 138 | 140 | 135 | 135 | 136 |
| warm / throttled@100MB/s|  62 |  62 |  62 |  62 |  62 |
| cold / throttled@100MB/s|  57 |  58 |  57 |  57 |  57 |

(`vs N=1` for the best column N=2: warm/unthrottled **+11.8 %**, cold/unthrottled
**+7.2 %**; throttled rows ≈ 0 %. N=16 regresses warm −4.4 %.)

## Conclusions

1. **N=2 is the sweet spot, not 8.** It wins or ties in 5 of 6 scenarios at the
   lowest fan-out: +11.8 % warm and +7.2 % cold on disk-bound reads, neutral when
   the consumer is the bottleneck. N=8 gives only +3.9 %/+4.8 %; N=16 regresses.
   So local now defaults to 2 (was 1); S3/Azure keep 8 (request-latency bound).

2. **The win is disk-bound, not network-bound.** Throttled (network-bound) rows
   are flat because `buffered(N)` here overlaps the per-chunk `File::open`
   (cheap on local disk), **not** the data read (which `try_flatten` polls
   sequentially). The disk-bound rows cover localhost/LAN downloads *and* the
   internal blob reads that drain as fast as the disk delivers — thumbnail
   render, transcode, ZIP export, content extraction — all via `stream_chunks`.

3. **No cold regression on SSD.** The trait doc's "slower cold" worry (concurrent
   opens → random I/O over scattered chunk files) is an HDD seek-thrash concern;
   on SSD-class storage cold reads *improved* at N=2. Operators on spinning disks
   can restore the old behaviour with `OXICLOUD_LOCAL_READ_PREFETCH=1`; NVMe
   arrays can raise it.
