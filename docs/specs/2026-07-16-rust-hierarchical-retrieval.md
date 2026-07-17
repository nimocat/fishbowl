# Rust Hierarchical Retrieval Core

**Date:** 2026-07-16
**Status:** Accepted direction; migration in progress

## Decision

Fishbowl will move all durable knowledge, retrieval, ranking, graph traversal,
Guardrail evaluation, transactions, redaction enforcement, and operational
metrics into Rust. TypeScript remains only for MCP protocol adaptation, HTTP
presentation, and the Trace Bench browser UI until those adapters can call the
Rust daemon directly.

The migration is incremental. The existing SQLite schema and daemon protocol
remain readable while Rust takes ownership one vertical slice at a time. No
second writable database is introduced.

## Research basis

- [RAPTOR](https://arxiv.org/abs/2401.18059) motivates recursive bottom-up
  summaries and retrieval across multiple abstraction levels.
- [From Local to Global GraphRAG](https://arxiv.org/abs/2404.16130) motivates
  hierarchical communities and separate local/global query paths.
- [HippoRAG](https://arxiv.org/abs/2405.14831) motivates single-step graph
  expansion with Personalized PageRank for multi-hop recall.
- [HNSW](https://arxiv.org/abs/1603.09320) motivates a multi-level approximate
  neighbor index for optional semantic candidate generation.
- [ColBERTv2](https://arxiv.org/abs/2112.01488) motivates late interaction only
  after cheap candidate pruning, not neural scoring over the full graph.
- [LightRAG](https://arxiv.org/abs/2410.05779) motivates dual-level retrieval
  and incremental graph updates.
- [Adaptive Radix Tree](https://db.in.tum.de/~leis/papers/ART.pdf) motivates
  cache-efficient in-memory prefix routing for fingerprints, paths, symbols,
  commands, and multilingual lexical prefixes.
- [Core-based Hierarchies for Efficient GraphRAG](https://arxiv.org/abs/2603.05207)
  identifies non-determinism in Leiden communities on sparse graphs and
  motivates deterministic k-core hierarchy construction.

## Retrieval architecture

The Rust engine uses three bounded stages:

1. **Deterministic routing tree** — exact fingerprint, project/worktree,
   file, symbol, command, platform, and lexical prefix indexes. ART or an
   equivalent compressed radix trie is the intended production structure.
2. **Hierarchical knowledge tree** — project → domain → deterministic k-core
   community → Case → node. Summaries are built bottom-up and revisioned.
   Queries descend only into promising branches and may retrieve both a
   summary and its supporting leaves.
3. **Graph expansion and reranking** — bounded Personalized PageRank over the
   selected subgraph, followed by optional HNSW candidates and late-interaction
   reranking. Verified exact knowledge always outranks approximate similarity.

Guardrails are evaluated independently of candidate limits. Blocking rules
cannot be pruned by tree descent or vector recall.

## Rust boundary

The target workspace is:

```text
crates/fishbowl-core       domain, policy, hierarchy, ranking, redaction contracts
crates/fishbowl-storage    SQLite schema, migrations, transactions, indexes
crates/fishbowl-retrieval  ART, hierarchy summaries, PPR, optional HNSW
crates/fishbowl-daemon     authenticated loopback RPC and process metrics
src/mcp               temporary TypeScript MCP adapter
src/web               TypeScript/JavaScript presentation only
```

The daemon protocol remains versioned JSON during migration. Once every core
operation is Rust-owned, TypeScript may not import storage or application
policy modules. Contract fixtures are shared between Rust and TypeScript.

## Efficiency measurement

Every migration round records the same metrics:

- cold and warm end-to-end p50/p95;
- daemon queue, execution, serialization, and transmission time;
- response bytes and selected branch/card counts;
- recall@k on a bilingual golden set;
- Guardrail recall, with blocking recall fixed at 100%;
- write calls and transactions per completed workflow;
- peak resident memory and index rebuild time.

Round zero observations:

- server-side preflight p50 was 17ms and p95 was 34ms in the active process;
- MCP end-to-end calls were commonly perceived at 3–6 seconds;
- compound Chinese query `轻量修复 三级验证门禁` returned no result for a
  stored `轻量代码修复采用三级风险验证门禁` Case;
- one verified Guardrail using several alternative task triggers did not match
  because the existing array means all-of;
- a complete structured workflow required multiple sequential MCP writes.

## Migration gates

1. Rust Unicode router and Guardrail semantics pass native tests.
2. TypeScript contract tests are replayed against Rust results.
3. Rust reads a copy of the current schema without mutation.
4. Query operations switch to Rust while writes remain TypeScript-owned.
5. Transactions and writes switch only after parity and rollback tests pass.
6. The TypeScript application/storage core is deleted only after the Rust
   daemon passes acceptance, migration, recovery, and performance gates.

No round is accepted solely because it is faster. Project isolation,
redaction, deterministic Guardrail behavior, idempotency, and evidence history
must remain equivalent or improve.
