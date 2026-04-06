# The Persistent Agent Framework

**A production-tested architecture for persistent, self-correcting AI agents built on Claude Code.**

---

## The Problem

Claude Code is stateless. Every session starts from zero. It doesn't remember what it learned yesterday, can't coordinate across terminals, and has no mechanism to improve its own behavior over time.

## The Solution

This framework turns Claude Code into a persistent operational partner with:

- **Persistent identity** across sessions via soul files and a shared database
- **Self-correcting behavior** where mistakes automatically become behavioral rules
- **Multi-terminal continuity** so parallel sessions share the same memory
- **Multi-platform presence** across CLI, Telegram, Discord, and web from a single agent definition
- **Autonomous operations** via a sweep-based daemon with circuit breakers
- **Agent onboarding** that discovers personality through conversation
- **Multi-provider LLM cascade** (Claude, Gemini, OpenAI, Ollama) with automatic fallback
- **Marker processing engine** for invisible side-effects (memory, state, learning) in LLM responses
- **Agent hierarchy** with subordinate agents, inter-agent communication, and security boundaries

No custom servers. No Docker. No Kubernetes. Built entirely on Claude Code (CLI), Supabase (persistence), and macOS launchd (scheduling).

## What's In This Repo

| Directory | Contents |
|-----------|----------|
| [`runtime/`](./runtime) | **Production runtime modules** — marker engine, agent boot, session manager, LLM providers, daemon runner, onboarding, tools, semantic memory |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Full architecture guide (20 sections) |
| [`templates/`](./templates) | Identity files: CLAUDE.md, SOUL.md, USER.md, HARNESS.md, SHIELD.md, launchd.plist |
| [`migrations/`](./migrations) | SQL schemas for Supabase (5 migration files) |
| [`hooks/`](./hooks) | Claude Code hook scripts for cross-session awareness |
| [`examples/`](./examples) | Working daemon entry point, settings.json, mcp.json |

### Runtime Modules

The `runtime/` directory contains production-tested, generic modules extracted from a live agent system:

| Module | Purpose |
|--------|---------|
| `marker-engine.mjs` | Brace-matching marker extraction, pluggable handler registry, strip-before-display |
| `agent-boot.mjs` | System prompt assembly from soul, memory, state, ledger, and session context |
| `session-manager.mjs` | Date-scoped sessions with automatic handoff on day boundary |
| `llm-providers.mjs` | Normalized interface across Claude, OpenAI, Gemini, Ollama with credential scrubbing |
| `tools.mjs` | Portable JSON Schema tool definitions with executors and provider format converters |
| `daemon.mjs` | Sweep-based daemon runner with circuit breakers and health monitoring |
| `onboarding.mjs` | Personality discovery flow — agent names itself through conversation |
| `semantic-memory.mjs` | Hybrid importance + semantic search with Ollama embeddings |
| `agent-config.mjs` | Multi-agent config loading with caching and role-based authorization |
| `config.mjs` | Centralized environment, model definitions, timeouts, and validation |
| `supabase-client.mjs` | Shared Supabase fetch wrapper with error handling |

## The Key Innovation: Self-Correction

Most agent frameworks focus on what the agent *can do*. This one focuses on how it *learns from what it did wrong*.

```
Mistake occurs
    -> Log to ledger (what, why, should_have, signal_traced)
    -> Daemon counts pattern frequency
    -> Pattern appears 3+ times?
        -> YES: Generate behavioral directive automatically
        -> Directive still violated? Escalate priority
        -> NO: Continue observing
```

The agent's personality literally evolves from its operational mistakes.

## Quick Start

### 1. Set up Supabase

Apply the migrations in order:
```bash
cat migrations/001_core_tables.sql | psql $DATABASE_URL
cat migrations/002_activity_tables.sql | psql $DATABASE_URL
cat migrations/003_operations.sql | psql $DATABASE_URL
cat migrations/004_rpc_functions.sql | psql $DATABASE_URL
cat migrations/005_conversations_and_tasks.sql | psql $DATABASE_URL
```

### 2. Create your agent directory

```bash
mkdir -p my-agent/soul
```

### 3. Copy and customize templates

```bash
# Root identity file (Claude Code loads this automatically)
cp templates/CLAUDE.md my-agent/CLAUDE.md

# Soul files define personality, operator profile, and technical self-awareness
cp templates/SOUL.md my-agent/soul/
cp templates/USER.md my-agent/soul/
cp templates/HARNESS.md my-agent/soul/
```

Fill in the `{placeholders}` in each file.

### 4. Register your agent in the database

```sql
INSERT INTO agent_config (agent_slug, owner_name, timezone)
VALUES ('my-agent', 'Your Name', 'America/Denver');
```

### 5. Set environment variables

```bash
export SUPABASE_URL="https://YOUR_PROJECT.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
export ANTHROPIC_API_KEY="your-key"  # Or any LLM provider key
```

### 6. Run the daemon

```bash
# Copy the example and customize
cp examples/daemon-entry.mjs my-agent/daemon.mjs
node my-agent/daemon.mjs --agent my-agent
```

### 7. Boot the CLI agent

```bash
cd my-agent && claude
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full deep-dive on every component.

## How the Marker Engine Works

Markers are inline tags in LLM output that trigger invisible side effects. The user never sees them — they're stripped before display.

```javascript
import { MarkerEngine, createDefaultEngine } from './runtime/index.mjs';

// Create engine with your persistence callbacks
const engine = createDefaultEngine({
  saveMemory: async (data) => { /* save to agent_memory */ },
  upsertState: async (data) => { /* save to agent_state */ },
  logWin: async (data) => { /* save to agent_ledger */ },
  logMistake: async (data) => { /* save to agent_ledger */ },
  saveJournal: async (data) => { /* your journal implementation */ },
});

// Or register custom markers
engine.register('CUSTOM_ACTION', async (data) => {
  // Your handler here
});

// Process LLM response
const { cleanText, results } = await engine.process(llmResponse);
// cleanText: markers stripped, ready to show to user
// results: array of { tag, data, result, error }
```

**Why brace-matching instead of regex?** LLMs frequently omit closing tags on long JSON payloads. Regex-based extraction (`[TAG]...[/TAG]`) silently loses data when the closing tag is missing. Brace-matching treats JSON as self-delimiting — it finds the matching `}` regardless of whether `[/TAG]` follows. This single architectural choice eliminated an entire class of silent data loss bugs.

## How the Daemon Works

```javascript
import { DaemonRunner, createTaskSweep, createEmbeddingSweep } from './runtime/index.mjs';

const daemon = new DaemonRunner('my-agent');

// Sweep: process conversation tasks every 10 seconds
daemon.addSweep('conversations', createTaskSweep('web_conversation', async (task) => {
  // Load agent, build prompt, call LLM, process markers, save response
}), { intervalMs: 10000 });

// Sweep: generate embeddings every 60 seconds
daemon.addSweep('embeddings', createEmbeddingSweep(generateEmbedding), { intervalMs: 60000 });

// Circuit breaker: 3 consecutive failures -> disable sweep + alert
daemon.start();
```

## How Onboarding Works

New agents don't start with a personality — they discover it through conversation with their owner.

```
Step 0: Introduction ("What brought you here?")
Step 1: Domains ("What would you like help with?")
Step 2: Communication style ("How do you like to be talked to?")
Step 3: Values & personality ("What do you value in a friend?")
Step 4: Naming (agent names itself or accepts a name)
Step 5: Complete — soul directives extracted and persisted
```

The result: an agent with 6-10 specific behavioral directives that actually reflect its owner's needs, not generic defaults.

## Prerequisites

- macOS (for launchd scheduling; adaptable to Linux systemd)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) authenticated
- Node.js 18+
- [Supabase](https://supabase.com) account (free tier works for development)
- [Ollama](https://ollama.ai) installed (optional, for local embeddings and semantic search)

## Security Considerations

This framework gives an AI agent persistent memory, autonomous execution, and broad filesystem access. That's powerful, and it requires intentional security hygiene.

**Environment isolation**
- Run your agent in a dedicated directory. Don't point it at your home folder.
- Use a separate machine or VM for production autonomous agents.
- Load secrets via environment variables, not files the agent can read.

**LLM provider security**
- The provider cascade scrubs credentials from prompts before sending to third-party providers.
- First-party providers (Anthropic, Ollama) skip scrubbing. Third-party providers (OpenAI, Gemini) scrub automatically.
- Review the SECRET_PATTERNS in `llm-providers.mjs` and add patterns for your credentials.

**MCP and tool access**
- MCP servers (email, calendar) are active attack surfaces — external content can contain prompt injection.
- Grant the minimum tool set needed per runtime mode. Use tool presets (`readonly`, `standard`, `full`).

**Autonomous operations**
- Daemon jobs run without human oversight. The circuit breaker pattern halts execution after 3 consecutive failures rather than retrying indefinitely.
- Monitor `agent_soul` for unexpected directive changes (the self-correction system writes to this table).

**Supply chain**
- Pin dependency versions. Don't let the agent install packages autonomously.
- The `SHIELD.md` instruction hierarchy (SHIELD > SOUL > user messages) resists prompt injection from external content.

## Architecture at a Glance

```
                    +------------------+
                    |    Supabase      |
                    | (shared backend) |
                    +--------+---------+
                             |
          +------------------+------------------+
          |                  |                  |
    +-----+------+    +-----+------+    +------+-----+
    |    CLI     |    |  Telegram  |    |  Discord   |
    | (claude)   |    |  Poller    |    |  Bot       |
    |            |    |  (daemon)  |    |  (daemon)  |
    +------------+    +------+-----+    +------+-----+
                             |                 |
                       +-----+-----------------+-----+
                       |         Daemon Runner       |
                       |  sweeps: tasks, embeddings, |
                       |  health, QA, proactive      |
                       |  circuit breaker protection  |
                       +-----------------------------+
```

All interfaces share the same memory, behavioral directives, and identity.

## Patterns Worth Stealing

Even if you don't adopt the full framework, these patterns stand alone:

- **Brace-matching marker extraction** - JSON is self-delimiting; don't rely on closing tags
- **Self-correction pipeline** - Mistakes become behavioral rules automatically
- **Signal tracing** - Log the specific signal misread, not just the pattern name
- **Hybrid memory loading** - Top-N by importance + top-M by semantic similarity
- **Date-scoped sessions** - New calendar day = new session, with handoff context from yesterday
- **Atomic task claiming** - Postgres RPCs prevent duplicate processing across processes
- **Provider cascade with credential scrubbing** - Try providers in order, scrub secrets for third-party
- **Circuit breakers** - 3 consecutive failures disable a sweep and alert
- **Onboarding through conversation** - The agent discovers its personality, not receives it
- **Authoritative date/time header** - Prevents LLM date hallucination in system prompts

## Built With

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) - The AI runtime
- [Supabase](https://supabase.com) - Persistence layer (Postgres + pgvector + RPCs)
- [Ollama](https://ollama.ai) - Local embedding generation (nomic-embed-text)
- macOS launchd - Service scheduling

## License

MIT. Use it, adapt it, make it yours. The architecture patterns are the contribution. Your soul, memory, and directives are your own.

---

*Built by [Rory Teehan](https://github.com/T33R0). 2026.*
