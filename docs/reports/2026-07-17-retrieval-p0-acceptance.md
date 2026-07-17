# Fishbowl Retrieval P0 Acceptance

## Scope

This slice upgrades the production Rust `queryKnowledge` orchestration without
changing schema v7 or the independently exhaustive Guardrail path:

1. exact FTS/file/command/fingerprint retrieval and deterministic fast return;
2. project/domain Unicode candidate routing;
3. true nested k-shell communities built from structural keys;
4. bounded candidate graph expansion with personalized PageRank;
5. deterministic evidence explanations, supporting paths, and bounded
   diagnostics;
6. revision-keyed in-memory cache invalidation.

HNSW, embeddings, LLM/RAPTOR summaries, schema v8, and TypeScript policy or
retrieval ownership remain intentionally out of scope. Generated summaries do
not confer trust. Verified blocking Guardrails remain exhaustive and are never
restricted by retrieval candidates.

## Deterministic limits

- candidate Cases: 64;
- graph seeds: 16;
- visited graph nodes: 256;
- visited graph edges: 1,024;
- PPR iterations: 20;
- explanation reasons and supporting path nodes: 8 each;
- structural key clique: ignored when shared by more than 64 Cases.

The response diagnostics contain deterministic counts and modes only. Runtime
durations stay in benchmark output rather than API data so identical queries
remain byte-deterministic.

## Quality evidence

The redacted engineering golden set contains 30 real engineering themes and
120 Chinese/English, omitted-word, and synonym-like queries. The strict exact
baseline recalled 39/120 (32.5%). Both the standalone Rust router and the full
schema-v7 production query pipeline recalled 116/120 (96.7%) at five results.
Every full-pipeline query also passed the candidate, graph, and iteration
budgets.

The production database shadow used a SQLite backup of the active default
database. Before and after candidate reads it remained schema v7 with
`quick_check=ok`, 1,313 events, 81 Cases, and 461 nodes. The candidate preserved
the known Rust migration Case for an established query. For the previously
empty query `rendering executor coalesced backpressure`, the installed engine
returned zero items while the candidate returned bounded project-local
streaming/rendering knowledge with reasons and paths.

## Performance evidence

On 10,000 Cases in Release:

- Unicode radix route-tree build: 86.176 ms; query p95: 3.625 microseconds;
- hierarchy build: 42.113 ms; one-branch incremental rebuild: 3.897 ms;
- exact full query cold: 0.561 ms; warm p95: 0.095 ms;
- hybrid full query cold: 110.254 ms; warm p95: 1.983 ms;
- bounded 10,000-node graph expansion p95: 13.314 ms.

Two measured implementation changes produced the largest gains. Replacing
per-community full-record scans removed a hidden quadratic hierarchy build and
reduced the 10,000-Case Debug cold query from 3,260.593 ms to 1,178.038 ms.
Reusing the hierarchy's already parsed records for the route tree removed a
second SQLite/JSON pass and reduced Release hybrid cold query from 401.039 ms
to 223.428 ms. Replacing the per-character Trie and repeated Case strings with
an interned Unicode radix tree then reduced route build from 159.219 ms to
86.176 ms and final hybrid cold query to 110.254 ms, exceeding the 20-30%
adoption threshold. The exact-evidence fast path reduced the Release exact cold
query from 267.747 ms to below 2 ms without weakening fuzzy or multi-hop
retrieval.

## Verification

- `cargo test --workspace`: pass;
- `cargo test --release --workspace`: pass after the final rerun;
- `cargo clippy --workspace --all-targets -- -D warnings`: pass;
- `cargo fmt --all -- --check`: pass;
- TypeScript typecheck: pass;
- production build: pass;
- Vitest: 13 files, 48 tests passed;
- schema-v7 production-copy probe and `quick_check`: pass;
- `git diff --check`: pass.

## Release boundary

The user explicitly authorized the production installation switch. Production
`main` was fast-forwarded from `3fc060d` to `48692d8`; the pre-existing untracked
design document was preserved. Rollback branch
`rollback/fishbowl-pre-retrieval-p0-20260717-024546` and quiesced SQLite backups under
`backups/retrieval-p0-cutover-20260717-024546` preserve the pre-cutover code and
both databases. Each backup passed `quick_check` and has a recorded SHA-256.

Immediately before installation, the platform-default database contained
1,320 events, 81 Cases, and 464 nodes. The legacy database contained 1,277
events, 81 Cases, and 447 nodes. Full-row `EXCEPT` checks across all 18
non-rebuildable business tables found zero legacy rows absent from the default
database, proving the default database was the authoritative strict superset.
No database replacement or schema migration was necessary.

Installed acceptance passed on the live schema-v7 database:

- exact lookup retained the migration Case on the zero-graph fast path;
- `rendering executor coalesced backpressure`, previously empty, returned five
  bounded hybrid results from seven candidate Cases after 20 PPR iterations;
- the production checkpoint was replayed with the same operation ID and the
  second call changed neither event nor node counts;
- final counts are 1,327 events, 81 Cases, and 467 nodes with
  `quick_check=ok`;
- one packaged Rust LaunchAgent owns the descriptor, listener, and database;
  no temporary benchmark daemon survived;
- health, static assets, projects, authenticated boundary, invalid Host
  rejection, and SSE passed;
- installed benchmark p95 is 0.327 ms warm RPC, 4.062 ms checkpoint, and
  0.034 ms daemon Preflight execution.

The deterministic retrieval P0 and its production installation are complete.
HNSW, embeddings, and RAPTOR-style summaries remain deliberately deferred and
non-authoritative.

## Production trust promotion

After the project owner explicitly approved promotion from the tested state to
production, Case `087bb44e-24ac-4a75-a49b-3a7f74935f89` was promoted from
candidate to verified. The immutable promotion chain contains verified
RootCause `8282369a-64a3-4b8b-a968-85af1c09ed93`, verified Solution
`3b338254-ab3e-4a45-99f1-65c5a1f2aa84`, successful automated Verification
`45fb7c0a-7303-4db1-968e-a1321cf8da61`, and successful human-confirmed
Verification `7d83a753-bc50-4f01-8ccb-981b0175ba09`. `close_case` reported no
missing promotion requirements, post-write integrity remained `quick_check=ok`,
and verified-only retrieval returned the promoted Case with `verified-trust`
evidence.
