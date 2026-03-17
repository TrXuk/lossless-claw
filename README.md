# lossless-claw

Lossless Context Management plugin for [OpenClaw](https://github.com/openclaw/openclaw), based on the [LCM paper](https://papers.voltropy.com/LCM) from [Voltropy](https://x.com/Voltropy). Replaces OpenClaw's built-in sliding-window compaction with a DAG-based summarization system that preserves every message while keeping active context within model token limits.

## Table of contents

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Documentation](#documentation)
- [Development](#development)
- [Vector and hybrid search: before vs after](#vector-and-hybrid-search-before-vs-after)
- [License](#license)

## What it does

Two ways to learn: read the below, or [check out this super cool animated visualization](https://losslesscontext.ai).

When a conversation grows beyond the model's context window, OpenClaw (just like all of the other agents) normally truncates older messages. LCM instead:

1. **Persists every message** in a SQLite database, organized by conversation
2. **Summarizes chunks** of older messages into summaries using your configured LLM
3. **Condenses summaries** into higher-level nodes as they accumulate, forming a DAG (directed acyclic graph)
4. **Assembles context** each turn by combining summaries + recent raw messages
5. **Provides tools** (`lcm_grep`, `lcm_describe`, `lcm_expand`) so agents can search and recall details from compacted history

Nothing is lost. Raw messages stay in the database. Summaries link back to their source messages. Agents can drill into any summary to recover the original detail.

**It feels like talking to an agent that never forgets. Because it doesn't. In normal operation, you'll never need to think about compaction again.**

## Quick start

### Prerequisites

- OpenClaw with plugin context engine support
- Node.js 22+
- An LLM provider configured in OpenClaw (used for summarization)

### Install the plugin

Use OpenClaw's plugin installer (recommended):

```bash
openclaw plugins install @martian-engineering/lossless-claw
```

If you're running from a local OpenClaw checkout, use:

```bash
pnpm openclaw plugins install @martian-engineering/lossless-claw
```

For local plugin development, link your working copy instead of copying files:

```bash
openclaw plugins install --link /path/to/lossless-claw
# or from a local OpenClaw checkout:
# pnpm openclaw plugins install --link /path/to/lossless-claw
```

The install command records the plugin, enables it, and applies compatible slot selection (including `contextEngine` when applicable).

### Configure OpenClaw

In most cases, no manual JSON edits are needed after `openclaw plugins install`.

If you need to set it manually, ensure the context engine slot points at lossless-claw:

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "lossless-claw"
    }
  }
}
```

Restart OpenClaw after configuration changes.

## Configuration

LCM is configured through a combination of plugin config and environment variables. Environment variables take precedence for backward compatibility.

### Plugin config

Add a `lossless-claw` entry under `plugins.entries` in your OpenClaw config:

```json
{
  "plugins": {
    "entries": {
      "lossless-claw": {
        "enabled": true,
        "config": {
          "freshTailCount": 32,
          "contextThreshold": 0.75,
          "incrementalMaxDepth": -1
        }
      }
    }
  }
}
```

**MongoDB Atlas and Vector Search:** To use MongoDB instead of SQLite and enable semantic/hybrid search, add these keys under `config`:

```json
{
  "plugins": {
    "entries": {
      "lossless-claw": {
        "enabled": true,
        "config": {
          "storageBackend": "mongodb",
          "mongodbUri": "mongodb+srv://user:pass@cluster.mongodb.net/",
          "mongodbDatabase": "lcm",
          "searchIndexMessages": "lcm_messages_search",
          "searchIndexSummaries": "lcm_summaries_search",
          "vectorSearchIndexMessages": "lcm_messages_vector",
          "vectorSearchIndexSummaries": "lcm_summaries_vector",
          "autoCreateAtlasIndexes": true,
          "freshTailCount": 32,
          "contextThreshold": 0.75
        }
      }
    }
  }
}
```

Set `autoCreateAtlasIndexes: true` to have Atlas Search and Vector Search indexes created automatically on first connection (M10+ cluster required).

| Config key | Description |
|------------|-------------|
| `storageBackend` | `"sqlite"` (default) or `"mongodb"` |
| `mongodbUri` | MongoDB connection URI (required when using MongoDB) |
| `mongodbDatabase` | Database name (default: `"lcm"`) |
| `searchIndexMessages` | Atlas Search (full-text) index for messages (default: `"lcm_messages_search"`) |
| `searchIndexSummaries` | Atlas Search (full-text) index for summaries (default: `"lcm_summaries_search"`) |
| `vectorSearchIndexMessages` | Atlas Vector Search index for messages (default: `"lcm_messages_vector"`) |
| `vectorSearchIndexSummaries` | Atlas Vector Search index for summaries (default: `"lcm_summaries_vector"`) |
| `autoCreateAtlasIndexes` | When `true`, create Atlas Search and Vector Search indexes if not present (default: `false`) |

Environment variables take precedence over plugin config, so you can override any of these with `LCM_*` env vars.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LCM_ENABLED` | `true` | Enable/disable the plugin |
| `LCM_DATABASE_PATH` | `~/.openclaw/lcm.db` | Path to the SQLite database |
| `LCM_CONTEXT_THRESHOLD` | `0.75` | Fraction of context window that triggers compaction (0.0–1.0) |
| `LCM_FRESH_TAIL_COUNT` | `32` | Number of recent messages protected from compaction |
| `LCM_LEAF_MIN_FANOUT` | `8` | Minimum raw messages per leaf summary |
| `LCM_CONDENSED_MIN_FANOUT` | `4` | Minimum summaries per condensed node |
| `LCM_CONDENSED_MIN_FANOUT_HARD` | `2` | Relaxed fanout for forced compaction sweeps |
| `LCM_INCREMENTAL_MAX_DEPTH` | `0` | How deep incremental compaction goes (0 = leaf only, -1 = unlimited) |
| `LCM_LEAF_CHUNK_TOKENS` | `20000` | Max source tokens per leaf compaction chunk |
| `LCM_LEAF_TARGET_TOKENS` | `1200` | Target token count for leaf summaries |
| `LCM_CONDENSED_TARGET_TOKENS` | `2000` | Target token count for condensed summaries |
| `LCM_MAX_EXPAND_TOKENS` | `4000` | Token cap for sub-agent expansion queries |
| `LCM_LARGE_FILE_TOKEN_THRESHOLD` | `25000` | File blocks above this size are intercepted and stored separately |
| `LCM_LARGE_FILE_SUMMARY_PROVIDER` | `""` | Provider override for large-file summarization |
| `LCM_LARGE_FILE_SUMMARY_MODEL` | `""` | Model override for large-file summarization |
| `LCM_SUMMARY_MODEL` | *(from OpenClaw)* | Model for summarization (e.g. `anthropic/claude-sonnet-4-20250514`) |
| `LCM_SUMMARY_PROVIDER` | *(from OpenClaw)* | Provider override for summarization |
| `LCM_AUTOCOMPACT_DISABLED` | `false` | Disable automatic compaction after turns |
| `LCM_PRUNE_HEARTBEAT_OK` | `false` | Retroactively delete `HEARTBEAT_OK` turn cycles from LCM storage |

### MongoDB Atlas and Vector Search (optional)

When using MongoDB Atlas as the storage backend, the following variables enable semantic and hybrid search via Voyage AI auto-embedding:

| Variable | Default | Description |
|----------|---------|-------------|
| `LCM_STORAGE_BACKEND` | `sqlite` | Storage backend: `sqlite` or `mongodb` |
| `LCM_MONGODB_URI` | — | MongoDB connection URI (required when `storageBackend` is `mongodb`) |
| `LCM_MONGODB_DATABASE` | `lcm` | MongoDB database name |
| `LCM_SEARCH_INDEX_MESSAGES` | `lcm_messages_search` | Atlas Search (full-text) index name for the `messages` collection |
| `LCM_SEARCH_INDEX_SUMMARIES` | `lcm_summaries_search` | Atlas Search (full-text) index name for the `summaries` collection |
| `LCM_VECTOR_SEARCH_INDEX_MESSAGES` | `lcm_messages_vector` | Atlas Vector Search index name for the `messages` collection |
| `LCM_VECTOR_SEARCH_INDEX_SUMMARIES` | `lcm_summaries_vector` | Atlas Vector Search index name for the `summaries` collection |
| `LCM_AUTO_CREATE_ATLAS_INDEXES` | `false` | When `true`, create Atlas Search and Vector Search indexes if not present |

**Prerequisites for vector/hybrid search:** Create Atlas Vector Search indexes with `autoEmbed` on the `content` field (see [planning-atlas.md](planning-atlas.md)). Voyage API keys are configured in Atlas, not in LCM. Alternatively, set `autoCreateAtlasIndexes: true` in plugin config to have indexes created automatically on first connection.

### Recommended starting configuration

```
LCM_FRESH_TAIL_COUNT=32
LCM_INCREMENTAL_MAX_DEPTH=-1
LCM_CONTEXT_THRESHOLD=0.75
```

- **freshTailCount=32** protects the last 32 messages from compaction, giving the model enough recent context for continuity.
- **incrementalMaxDepth=-1** enables unlimited automatic condensation after each compaction pass — the DAG cascades as deep as needed. Set to `0` (default) for leaf-only, or a positive integer for a specific depth cap.
- **contextThreshold=0.75** triggers compaction when context reaches 75% of the model's window, leaving headroom for the model's response.

### OpenClaw session reset settings

LCM preserves history through compaction, but it does **not** change OpenClaw's core session reset policy. If sessions are resetting sooner than you want, increase OpenClaw's `session.reset.idleMinutes` or use a channel/type-specific override.

```json
{
  "session": {
    "reset": {
      "mode": "idle",
      "idleMinutes": 10080
    }
  }
}
```

- `session.reset.mode: "idle"` keeps a session alive until the idle window expires.
- `session.reset.idleMinutes` is the actual reset interval in minutes.
- OpenClaw does **not** currently enforce a maximum `idleMinutes`; in source it is validated only as a positive integer.
- If you also use daily reset mode, `idleMinutes` acts as a secondary guard and the session resets when **either** the daily boundary or the idle window is reached first.
- Legacy `session.idleMinutes` still works, but OpenClaw prefers `session.reset.idleMinutes`.

Useful values:

- `1440` = 1 day
- `10080` = 7 days
- `43200` = 30 days
- `525600` = 365 days

For most long-lived LCM setups, a good starting point is:

```json
{
  "session": {
    "reset": {
      "mode": "idle",
      "idleMinutes": 10080
    }
  }
}
```

## Documentation

- [Configuration guide](docs/configuration.md)
- [Architecture](docs/architecture.md)
- [Agent tools](docs/agent-tools.md)
- [TUI Reference](docs/tui.md)
- [lcm-tui](tui/README.md)
- [Optional: enable FTS5 for fast full-text search](docs/fts5.md)

## Development

```bash
# Run tests
npx vitest

# Type check
npx tsc --noEmit

# Run a specific test file
npx vitest test/engine.test.ts
```

### Project structure

```
index.ts                    # Plugin entry point and registration
src/
  engine.ts                 # LcmContextEngine — implements ContextEngine interface
  assembler.ts              # Context assembly (summaries + messages → model context)
  compaction.ts             # CompactionEngine — leaf passes, condensation, sweeps
  summarize.ts              # Depth-aware prompt generation and LLM summarization
  retrieval.ts              # RetrievalEngine — grep, describe, expand operations
  expansion.ts              # DAG expansion logic for lcm_expand_query
  expansion-auth.ts         # Delegation grants for sub-agent expansion
  expansion-policy.ts       # Depth/token policy for expansion
  large-files.ts            # File interception, storage, and exploration summaries
  integrity.ts              # DAG integrity checks and repair utilities
  transcript-repair.ts      # Tool-use/result pairing sanitization
  types.ts                  # Core type definitions (dependency injection contracts)
  openclaw-bridge.ts        # Bridge utilities
  db/
    config.ts               # LcmConfig resolution from env vars
    connection.ts           # SQLite connection management
    migration.ts            # Schema migrations
  store/
    conversation-store.ts   # Message persistence and retrieval
    summary-store.ts        # Summary DAG persistence and context item management
    fts5-sanitize.ts        # FTS5 query sanitization
  tools/
    lcm-grep-tool.ts        # lcm_grep tool implementation
    lcm-describe-tool.ts    # lcm_describe tool implementation
    lcm-expand-tool.ts      # lcm_expand tool (sub-agent only)
    lcm-expand-query-tool.ts # lcm_expand_query tool (main agent wrapper)
    lcm-conversation-scope.ts # Conversation scoping utilities
    common.ts               # Shared tool utilities
test/                       # Vitest test suite
specs/                      # Design specifications
openclaw.plugin.json        # Plugin manifest with config schema and UI hints
tui/                        # Interactive terminal UI (Go)
  main.go                   # Entry point and bubbletea app
  data.go                   # Data loading and SQLite queries
  dissolve.go               # Summary dissolution
  repair.go                 # Corrupted summary repair
  rewrite.go                # Summary re-summarization
  transplant.go             # Cross-conversation DAG copy
  prompts/                  # Depth-aware prompt templates
.goreleaser.yml             # GoReleaser config for TUI binary releases
```

## Vector and hybrid search: before vs after

When using **SQLite** (the default), search is keyword-based: `lcm_grep` matches exact terms or regex patterns. When you enable **MongoDB Atlas** with Vector Search indexes and Voyage AI auto-embedding, you gain semantic and hybrid search modes.

### Before (keyword-only)

| Capability | Behavior |
|------------|----------|
| Find by exact words | Yes — FTS5, LIKE, or regex |
| Find by meaning/intent | No — only literal matches |
| Answer questions over history | Limited — requires keyword overlap |
| "Similar to this" search | No |

Example: Searching for `"authentication"` will not find messages about "login flow" or "user credentials" unless those exact words appear.

### After (vector + hybrid enabled)

| Capability | Behavior |
|------------|----------|
| Find by exact words | Yes — unchanged |
| Find by meaning/intent | Yes — semantic search finds conceptually related content |
| Answer questions over history | Yes — `lcm_expand_query` can retrieve by meaning |
| "Similar to this" search | Yes — vector similarity |

Example: Searching for `"how do we handle errors"` can find summaries about "exception handling", "try/catch", or "debugging failures" even when those exact phrases are absent.

**Search modes when Atlas is enabled:**

- `mode: "full_text"` — Keyword search (unchanged)
- `mode: "semantic"` — Vector-only search by meaning
- `mode: "hybrid"` — Keyword + vector, merged with Reciprocal Rank Fusion for best of both

On SQLite, `hybrid` and `semantic` fall back to keyword search, so existing workflows remain compatible.

## License

MIT
