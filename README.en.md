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
