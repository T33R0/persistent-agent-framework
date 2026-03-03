-- Persistent Agent Framework: Core Tables
-- Apply first. These are the foundational persistence tables.

-- Enable pgvector extension (for semantic search)
CREATE EXTENSION IF NOT EXISTS vector;

-- Persistent knowledge store
CREATE TABLE IF NOT EXISTS agent_memory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key TEXT UNIQUE NOT NULL,
    content TEXT NOT NULL,
    category TEXT,
    tags TEXT[],
    importance INTEGER DEFAULT 50 CHECK (importance BETWEEN 1 AND 100),
    source_session TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    embedding VECTOR(768),
    embedded_at TIMESTAMPTZ
);

-- Behavioral directives (the soul)
CREATE TABLE IF NOT EXISTS agent_soul (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    directive TEXT NOT NULL,
    category TEXT,
    priority INTEGER DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    embedding VECTOR(768),
    embedded_at TIMESTAMPTZ
);

-- Wins and mistakes (the ledger)
CREATE TABLE IF NOT EXISTS agent_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entry_type TEXT NOT NULL CHECK (entry_type IN ('win', 'mistake')),
    what TEXT NOT NULL,
    why TEXT,
    should_have TEXT,
    pattern TEXT,
    severity TEXT CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    recurrence INTEGER DEFAULT 1,
    status TEXT DEFAULT 'active',
    tags TEXT[],
    signal_traced TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    embedding VECTOR(768),
    embedded_at TIMESTAMPTZ
);

-- Background tasks and queued messages
CREATE TABLE IF NOT EXISTS agent_heartbeat (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task TEXT NOT NULL,
    description TEXT,
    category TEXT,
    priority INTEGER DEFAULT 3,
    status TEXT DEFAULT 'pending',
    scheduled_for TIMESTAMPTZ,
    recurrence TEXT,
    max_retries INTEGER DEFAULT 3,
    retry_count INTEGER DEFAULT 0,
    result TEXT,
    error TEXT,
    completed_at TIMESTAMPTZ,
    created_by_session TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Session summaries
CREATE TABLE IF NOT EXISTS agent_session_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    log_date DATE,
    session_id TEXT,
    summary TEXT,
    topics TEXT[],
    decisions_made TEXT[],
    tasks_created TEXT[],
    model_used TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_memory_importance ON agent_memory (importance DESC);
CREATE INDEX IF NOT EXISTS idx_memory_category ON agent_memory (category);
CREATE INDEX IF NOT EXISTS idx_ledger_entry_type ON agent_ledger (entry_type);
CREATE INDEX IF NOT EXISTS idx_ledger_pattern ON agent_ledger (pattern);
CREATE INDEX IF NOT EXISTS idx_ledger_created ON agent_ledger (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_soul_active ON agent_soul (active) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_heartbeat_status ON agent_heartbeat (status);
CREATE INDEX IF NOT EXISTS idx_heartbeat_scheduled ON agent_heartbeat (scheduled_for);
