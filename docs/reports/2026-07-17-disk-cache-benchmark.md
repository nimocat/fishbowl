# Persistent disk cache benchmark

## Scope

The candidate schema-v9 binary scanned the real
`/Users/eric/yqshunjian-ios-codex` tree through an isolated database. The prior
installed schema-v8 task-end measurement is the production baseline. Wall time
includes the CLI/RPC round trip.

## Results

| Scenario | Wall time | Scanned entries | Cache hits/misses | Tracked bytes |
| --- | ---: | ---: | ---: | ---: |
| Installed v8 baseline | 6.73 s | 250,000 | 0 / n/a | 17,689,142,384 |
| Candidate v9 cold population | 4.27 s | 250,000 | 0 / 22 | 16,102,794,504 |
| Candidate v9 hot start | 0.47 s | 46,423 | 22 / 0 | 21,257,150,189 |
| Candidate v9 hot finish | 0.28 s | 46,423 | 22 / 0 | 21,257,150,189 |
| Candidate v9 one-root invalidation | 0.29 s | 46,477 | 21 / 1 | 21,257,150,214 |

The unchanged hot start is 93.0% faster than the 6.73-second baseline. The hot
finish is 95.8% faster. Adding a 25-byte file under one generated-output root
invalidated exactly that root; removing it produced a measured `-25` byte
delta, 21 hits, and one miss.

The first bounded population remained partial at 250,000 entries. A following
pass filled the seven roots that had no remaining cold-scan budget, after which
all 22 roots hit and the ledger retained 21.26 GB of artifact estimates. This
is more coverage than the prior 17.69 GB bounded snapshot without increasing
the per-pass entry ceiling. Cache-hit observations remain review-only.
