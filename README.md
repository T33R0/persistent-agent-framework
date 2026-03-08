# The Persistent Agent Framework

**A replicable architecture for persistent, self-correcting AI agents built on Claude Code.**

---

## The Problem

Claude Code is stateless. Every session starts from zero. It doesn't remember what it learned yesterday, can't coordinate across terminals, and has no mechanism to improve its own behavior over time.

## The Solution

This framework turns Claude Code into a persistent operational partner with:

- **Persistent identity** across sessions via soul files and a shared database
- **Self-correcting behavior** where mistakes automatically become behavioral rules
- **Multi-terminal continuity** so parallel sessions share the same memory
- **Multi-platform presence** across CLI, Telegram, and Discord from a single agent definition
- **Autonomous operations** via scheduled daemon jobs
- **Agent hierarchy** with subordinate agents, inter-agent communication, and security boundaries

No custom servers. No Docker. No Kubernetes. Built entirely on Claude Code (CLI), Supabase (persistence), and macOS launchd (scheduling).

## The Key Innovation: Self-Correction

Most agent frameworks focus on what the agent *can do*. This one focuses on how it *learns from what it did wrong*.

```
Mistake occurs
    -> Log to ledger (what, why, should_have, signal_traced)
    -> Auto-remediation daemon counts pattern frequency
    -> Pattern appears 3+ times?
        -> YES: Generate behavioral directive automatically
        -> Directive still violated? Escalate priority
        -> NO: Continue observing
```

The agent's personality literally evolves from its operational mistakes. A directive earned through repeated failure carries more weight than a static instruction.

## What's In This Repo

This is an **architecture reference**, not a software package. It contains the patterns, schemas, templates, and operational lessons from building and running a persistent agent system in daily production.

| Directory | Contents |
|-----------|----------|
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Full architecture guide (20 sections) |
| [`templates/`](./templates) | Identity files: CLAUDE.md, SOUL.md, USER.md, HARNESS.md, SHIELD.md |
| [`migrations/`](./migrations) | SQL schemas for Supabase (one-command setup) |
| [`hooks/`](./hooks) | Claude Code hook scripts for cross-session awareness |
| [`examples/`](./examples) | Configuration examples (settings.json, mcp.json) |

### Maturity Levels

The architecture guide covers features at different maturity levels. Each section in [ARCHITECTURE.md](./ARCHITECTURE.md) is marked with one of:

| Marker | Meaning |
|--------|---------|
| **Included** | Schemas, templates, or example code included in this repo. Ready to use. |
| **Production** | In active daily use by the reference implementation. Validated through real operations. |
| **Pattern Reference** | Architecture documented from a working system. Implementation code not included, but the pattern is fully described and tested. Build your own from the description. |

## Quick Start

1. **Create your directory structure**
   ```bash
   mkdir -p my-agent/{command_and_general_staff/deputy/your-agent/{soul,memory/daily,scripts/lib,skills,logs},operations,planning,logistics,finance,staging}
   ```

2. **Set up Supabase** - Apply the migrations in order
   ```bash
   # Via Supabase dashboard SQL editor or CLI
   cat migrations/001_core_tables.sql | psql $DATABASE_URL
   cat migrations/002_activity_tables.sql | psql $DATABASE_URL
   cat migrations/003_operations.sql | psql $DATABASE_URL
   cat migrations/004_rpc_functions.sql | psql $DATABASE_URL
   ```

3. **Copy and customize templates** - Start with `templates/CLAUDE.md`, fill in your agent's identity

4. **Configure MCP** - Copy `examples/mcp.json` to your project root as `.mcp.json`

5. **Install hooks** - Copy `hooks/` scripts and configure in `.claude/settings.json`

6. **Boot** - `cd my-agent && claude`

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full setup guide and deep explanation of every component.

## Prerequisites

- macOS (for launchd scheduling; adaptable to Linux systemd)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) authenticated
- Node.js 18+
- [Supabase](https://supabase.com) account (free tier works for development)
- [Ollama](https://ollama.ai) installed (optional, for local embeddings)

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
    |            |    |  (launchd) |    |  (launchd) |
    +------------+    +------------+    +------------+
          |
    +-----+------+
    |   Daemon   |
    | (launchd)  |
    | scheduled  |
    | autonomous |
    |   jobs     |
    +------------+
```

All interfaces share the same memory, behavioral directives, and identity. Cross-platform conversation history is maintained through Supabase RPCs.

## Patterns Worth Stealing

Even if you don't adopt the full framework, these patterns stand alone:

- **Self-correction pipeline** - Mistakes become behavioral rules automatically
- **Signal tracing** - Log the specific signal misread, not just the pattern name
- **Hybrid memory loading** - Top-N by importance + top-M by semantic similarity
- **Atomic task claiming** - Postgres RPCs prevent duplicate processing across processes
- **Session persistence** - Full boot on first interaction, `--resume` after, 80% token savings
- **Learning enforcement** - Tiered reminders that escalate as sessions get longer
- **Circuit breakers** - 3 consecutive failures disable a job and alert the operator

## Built With

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) - The AI runtime
- [Supabase](https://supabase.com) - Persistence layer (Postgres + pgvector + RPCs)
- [Ollama](https://ollama.ai) - Local embedding generation (nomic-embed-text)
- macOS launchd - Service scheduling

## License

MIT. Use it, adapt it, make it yours. The architecture patterns are the contribution. Your soul, memory, and directives are your own.

---

*Built by [Rory Teehan](https://github.com/T33R0). February 2026.*
