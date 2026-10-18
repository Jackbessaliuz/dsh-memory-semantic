# dsh-memory-semantic

> A semantic retrieval layer for the [meow-memory](https://www.npmjs.com/package/meow-memory) memory system — so what has been *recorded* can actually be *recalled*.

A [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) plugin. It reads your memory database **read-only**, builds a local vector index, and adds three things to your AI: **semantic search**, a **memory graph**, and **verbatim conversation recall**.

[中文说明](README.md)

> ⚠️ **The Chinese [README.md](README.md) is the source of truth** and is updated first;
> this English version may lag behind it.

## How memory runs

```
┌─ Store ───────────────────────────────────────────────────────┐
│                                                               │
│   Shelf A: knowledge (meow-memory)   Shelf B: raw turns (this)│
│   ───────────────────────────────    ──────────────────────── │
│   book  = notes the AI wrote          book = the dialogue     │
│           (soul/user/rules/fact/             itself, verbatim  │
│            lesson/topic/project)             + one-line label │
│   who   = the AI, deliberately        who  = written for you, │
│   keeps = dream (dedupe/archive)      keeps = nothing (append)│
│   means = "what I know"               means = "what was       │
│                                                actually said" │
└───────────────────────────────────────────────────────────────┘
                              │
┌─ Find ────────────────────────┴───────────────────────────────┐
│   Shelf A: memory_search     (keywords)                       │
│            memory_semantic   (vector + keywords fused)        │
│            memory_graph      (importance, topics, neighbours) │
│   Shelf B: recall_turns      (the verbatim exchange)          │
└───────────────────────────────────────────────────────────────┘
                              │
┌─ Deliver (pushed to the model) ┴─────────────────────────────┐
│   ① first-turn long-term memory injection                     │
│   ② action-triggered injection (rules & lessons)              │
│   ③ cross-session handoff ("continue" in a new session)       │
│   ④ recall injection (relevant raw turns, every turn)         │
└───────────────────────────────────────────────────────────────┘
```

**In one line**: meow-memory *stores*; this plugin *finds* and *delivers*.
---

## The problem

Keyword search hits three walls:

1. **Different words, same meaning.** Your memory says `thresholdRatio lowered`; you search "context is too full" — zero hits.
2. **No sense of importance.** Once there are hundreds of entries, which ones are hubs and which are trivia is not something you can eyeball.
3. **Summaries eat the details.** Long conversations get compacted into summaries; when you actually need the original wording, it is gone.

This plugin adds all three **on top of the same memory database**, without changing the original system.

## Boundary with meow-memory (important)

|  | meow-memory | dsh-memory-semantic |
|---|---|---|
| Role | **Base**: writing, layering, curating memories | **Enhancement**: read-only retrieval |
| Database | `<workspace>/.dsh-meow/memory.db` | its own `<workspace>/.dsh-semantic/*` |
| Effect on the other | — | **never writes, never modifies** |

Two hard rules:

- The plugin always opens the memory database **read-only**: no tables created, no rows written, no schema changes.
- **Uninstall it and meow-memory keeps working exactly as before, with all its data intact.**

Either works alone; together they are "remember" plus "recall".

## Features

### Three tools

| Tool | What it does |
|---|---|
| `memory_semantic` | Semantic memory search: local embeddings + BM25, fused with RRF |
| `memory_graph` | Memory graph: global importance (weighted PageRank), knowledge domains (communities), similar neighbours |
| `recall_turns` | **Verbatim** recall: find the actual question-and-answer text from earlier conversations |

### Automatic wiring

- **Cross-session relay** — say "continue" in a new session and the tail of the previous one is carried over automatically.
- **Action-triggered injection** — when a risky action is detected (editing config, touching data), relevant rules and lessons are retrieved and attached to the next request.
- **Injection ledger** — each memory is injected at most once per session.
- **Context assembly** — retrieved passages are inserted **before the current question**, with a size cap.

### Settings page

After installation a **Semantic Memory** page appears in DSH settings: vector engine availability, index size, turn-store size, graph size, the effective retrieval/graph parameters, and suggested host compaction presets.

The **Ollama auto-start** toggle can be switched right there — it takes effect immediately (stored in the plugin's own `~/.dsh/dsh-memory-semantic.runtime.json`, never touching host configuration).

## Install

### Option 1 — command line (CLI / web profile)

```
dsh plugin --profile <profile-name> add github:Jackbessaliuz/dsh-memory-semantic
```

> `dsh plugin` passes its arguments **straight through to pnpm** inside the profile, so `add` / `remove` / `update` all work.
> ⚠️ **On the desktop app (Electron) the `desktop` profile is owned exclusively by the application** and cannot be driven from the CLI — install through the app's own plugin manager instead.

The package declares a `dsh.bundle.patch`, so the installer/reconciler adds it to the current profile's bundles automatically. **Restart DSH to take effect** (host-side plugins are not hot-reloaded).

### Option 2 — local development (link)

```bash
npm i link:<path-to-this-repo>
```

then insert a `dsh-memory-semantic` entry into the profile's `cordis.patch.yml` by hand.

> Do not do both — bundles *and* a manual insert for the same entry will fail with a duplicate entry id.

## Troubleshooting

- **`allowBuilds` / blocked build script** — pnpm 10+ blocks install-time scripts. This package has none (plain JS), but a sibling in the same install may trigger it — most often `meow-memory`, which ships a `prepare`. Follow pnpm's printed instruction, add the key to the profile's `pnpm-workspace.yaml`, then re-run.
- **Official desktop app** — its `desktop` profile is owned by the app; install through the in-app plugin manager, not the CLI.
- **Installed but nothing happens** — restart DSH: host-side plugins are not hot-reloaded.
- **Search feels dumber than expected** — Ollama is not running, so it fell back to keyword-only search. That is by design, not a failure.

### For an AI assistant installing this

1. Make sure `meow-memory` is present first — this plugin only reads its database and does nothing on its own.
2. `dsh plugin --profile <profile> add github:Jackbessaliuz/dsh-memory-semantic`
3. Restart DSH afterwards.
4. Verify: `dsh-memory-semantic` must appear **exactly once** in `dsh --profile <profile> --dump-config` (not available on the official desktop app — use its plugin manager instead).

## Configuration

Every knob lives in the profile patch `config:` section; no code changes needed:

```yaml
- id: dsh-memory-semantic
  name: 'dsh-memory-semantic'
  config:
    ollama:
      url: http://127.0.0.1:11434
      model: bge-m3
      autoStart: false        # true = try to start Ollama in the background
      executablePath: ''      # for portable / custom installs
      probeTimeoutMs: 800
      warmupWaitMs: 0         # 0 = fire and forget; this turn falls back to BM25
      embedBatch: 32
    retrieval:
      rrfK: 60
      rrfPool: 10
      outputChars: 220
      queryInstruction: '为这个句子生成表示以用于检索相关文章：'
    graph:
      topK: 8
      edgeThreshold: 0.62     # cosine threshold; higher = more fragmented communities
      damping: 0.85
      prIterations: 50
      lpMaxIter: 50
```

**Any invalid value silently falls back to its default** — a bad config never breaks plugin loading.

## Ollama is optional

- **Installed** — vector + BM25 fused retrieval, better recall.
- **Missing / not running** — degrades to **plain BM25**; everything keeps working, only semantic generalisation is weaker.

The plugin never errors or blocks because Ollama is absent. With `autoStart: true` it tries to start Ollama **in the background without blocking the current turn**.

## Token cost (measured)

The plugin adds **two small costs**. meow-memory's own overhead does **not** change — this plugin only reads its database:

| Cost | Where it happens | Measured (median-length turn, 150 real turns) |
|---|---|---|
| One extraction per turn | background call, **not in your chat context** | ≈ 2,600 input + 240 output tokens |
| Recall injection | inserted before your question, **counts as context** | ≤ ≈ 1,100 tokens (k=3, 1200-char cap) |

Roughly 260k input + 24k output tokens per day at 100 turns/day; longer answers cost more than the median.
Both halves can be turned off independently: `turns.live.enabled: false` stops auto-extraction (you keep the three tools), `turns.recallShadow.inject: false` stops auto-injection (already-recorded turns stay searchable). Extraction is pinned to a low reasoning effort by default, so a cheap model is fine.

## Changelog

### 1.1.0 (2026-10-18)

**Performance**
- Lexical recall moved from "rebuild BM25 over the whole store every turn" to **SQLite FTS5** (Chinese indexed as bigrams, the same tokenization the in-memory BM25 used). Measured at 1,391 turns the fixed per-turn cost went **440 ms → 6–17 ms**, and it no longer grows linearly with the store.
- Migration is automatic: the first time the database is opened it builds the FTS index and backfills existing turns (≈0.7 s for 1,424 rows, one-off), then stays in sync incrementally. No manual rebuild.

**Degeneration guard (thinking-guard merged in)**
- New `guard` config section: degenerate reasoning blocks are folded out of the **model-visible history** (the log keeps the original text; the human-facing transcript is unaffected). The criteria are the standalone thinking-guard's (calibrated on 235 sessions, one ruler for Chinese verbatim repetition and one for short English sentence rotation).
- Enabling it for the first time with `guard.dryRun: true` for a day is recommended before real folding.

**Ollama auto-start**
- `autoStart` now probes/spawns **when the plugin starts**, not only when the `memory_semantic` tool is called, and a low-frequency watchdog re-spawns Ollama every 5 minutes if it exits.
- Settings-page copy updated: with autoStart on but Ollama not running it now says "starts automatically on launch" instead of reporting a degraded state.

**Graph**
- `memory_graph rebuild` is now a **background task**, building in chunks that yield the event loop (previously 1.4 s for 820 nodes and 13 s for 3,000 nodes, blocking the host throughout).
- New "Rebuild graph" button on the settings page (async, with state, usable even before a graph exists) and a staleness hint (> 7 days).

**Fixes**
- Turn ids are derived from `(sessionId, userSeq)`, matching the table's `UNIQUE(session_id, user_seq)` — this removes the observed `UNIQUE constraint failed` when two answerSeqs were computed for the same turn.
- The write sequence (turn + triples + queue state + watermark) runs in **one transaction**; on failure it rolls back and records `failed` with backoff — no more "half-written turn + permanently pending queue".
- Blank-string checks in the contract layer now use `trim()`, matching the storage layer, so a contract can no longer pass and then have storage throw.
- `recoverLimit` / `guardCooldownMs` added to normalization (previously they could be set and silently did nothing).
- `embedTexts` gained a timeout (8 s): a half-dead Ollama no longer blocks the host's serial chain forever.
- Fusion weights now actually use `ROUTE_WEIGHTS` (previously a dead constant, so production ran equal-weight); `routes` labels are consistent (the gated branch used to mislabel vector/graph backfill as bm25); the graph route keeps only the top 20% by score instead of letting the long tail dilute RRF.

## Data & privacy

- **Everything stays local.** The vector index, graph and turn store live under `.dsh-semantic/` in your own workspace.
- **Embedding requests only go to your local Ollama** (`127.0.0.1:11434` by default).
- The memory database is opened **read-only**; nothing in meow-memory is ever modified.
- A built-in **redaction gate** strips GitHub tokens, API keys, private keys and similar secrets before they can reach the turn store.

## Credits

The **turn-memory data model, the recall algorithms and the surface-takeover range semantics** are ported from
[graph-memory](https://github.com/adoresever/graph-memory) (MIT License, © 2026 adoresever).
The skeleton follows its design; the implementation was rewritten against DSH's plugin interfaces. Many thanks.

## License

[MIT](LICENSE)
