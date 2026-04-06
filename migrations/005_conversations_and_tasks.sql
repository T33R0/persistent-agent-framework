-- Persistent Agent Framework: Conversations, Tasks, Sessions, and Config
-- Apply after 004_rpc_functions.sql
-- These tables power the runtime: async task processing, cross-platform
-- conversations, session continuity, and multi-agent configuration.

-- ══════════════════════════════════════════════════════════════
-- Agent Configuration
-- ══════════════════════════════════════════════════════════════

-- Each agent has a config row. Supports multiple agents per Supabase project.
CREATE TABLE IF NOT EXISTS agent_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_slug TEXT UNIQUE NOT NULL,         -- Short identifier (e.g. 'lee', 'buddy')
    agent_name TEXT,                          -- Display name (set during onboarding)
    owner_name TEXT NOT NULL,                 -- Who this agent serves
    owner_telegram_id TEXT,                   -- For Telegram authorization
    creator_telegram_id TEXT,                 -- Creator (may differ from owner)
    timezone TEXT DEFAULT 'America/Denver',   -- IANA timezone for session boundaries
    config JSONB DEFAULT '{}'::jsonb,         -- Runtime settings (bot token env vars, etc.)
    onboarding_complete BOOLEAN DEFAULT false,
    onboarding_step INTEGER DEFAULT 0,       -- 0-5 (intro, domains, style, values, naming)
    status TEXT DEFAULT 'pending_onboarding'
        CHECK (status IN ('pending_onboarding', 'onboarding', 'active', 'paused')),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- ══════════════════════════════════════════════════════════════
-- Agent State (Key-Value)
-- ══════════════════════════════════════════════════════════════

-- Flexible key-value store for runtime state: session tracking,
-- emotional context, ongoing threads, owner context, etc.
CREATE TABLE IF NOT EXISTS agent_state (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key TEXT UNIQUE NOT NULL,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_state_key ON agent_state (key);

-- ══════════════════════════════════════════════════════════════
-- Conversations (Cross-Platform)
-- ══════════════════════════════════════════════════════════════

-- All messages across all platforms in one table.
-- Telegram, Discord, web — all flow through here.
CREATE TABLE IF NOT EXISTS agent_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID REFERENCES agent_config(id),
    platform TEXT NOT NULL,                   -- 'telegram', 'discord', 'web'
    platform_user_id TEXT NOT NULL,           -- Platform-specific user identifier
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,       -- reply_to, reactions, image_url, etc.
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversations_platform_user
    ON agent_conversations (platform, platform_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_agent
    ON agent_conversations (agent_id, created_at DESC);

-- ══════════════════════════════════════════════════════════════
-- Task Queue (Async Work Bus)
-- ══════════════════════════════════════════════════════════════

-- The central work queue. Platforms insert tasks, the daemon claims and processes them.
-- Task types: 'web_conversation', 'telegram_reply', 'proactive', 'scheduled',
--             'cross_mode', 'daemon_circuit_breaker', etc.
CREATE TABLE IF NOT EXISTS agent_task_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task TEXT NOT NULL,                        -- Task type identifier
    payload JSONB DEFAULT '{}'::jsonb,         -- Task-specific data
    priority INTEGER DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
    status TEXT DEFAULT 'pending'
        CHECK (status IN ('pending', 'claimed', 'completed', 'failed', 'cancelled')),
    agent_id UUID REFERENCES agent_config(id),
    claimed_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error TEXT,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_queue_status ON agent_task_queue (status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_task_queue_task ON agent_task_queue (task, status);

-- ══════════════════════════════════════════════════════════════
-- Session Handoff (Day-Boundary Context Transfer)
-- ══════════════════════════════════════════════════════════════

-- Written when a session expires (new calendar day). Contains enough context
-- for the next session's boot to understand what happened yesterday.
CREATE TABLE IF NOT EXISTS agent_session_handoff (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID REFERENCES agent_config(id),
    active_topics TEXT,                        -- Semicolon-separated topic summaries
    owner_mood TEXT,                           -- Emotional context from last session
    open_threads TEXT,                         -- Unresolved conversation threads
    next_session_context TEXT,                 -- Explicit context for next boot
    message_count INTEGER DEFAULT 0,
    platform TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_handoff_created ON agent_session_handoff (created_at DESC);

-- ══════════════════════════════════════════════════════════════
-- RPC Functions
-- ══════════════════════════════════════════════════════════════

-- Atomic task claiming: prevents duplicate processing when multiple
-- daemon instances or pollers run simultaneously.
CREATE OR REPLACE FUNCTION claim_agent_task(p_task_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
AS $$
    UPDATE agent_task_queue
    SET status = 'claimed', claimed_at = now()
    WHERE id = p_task_id AND status = 'pending'
    RETURNING true;
$$;

-- Claim next pending task of a given type (FIFO with priority).
-- Returns the full task row or empty set if nothing available.
CREATE OR REPLACE FUNCTION claim_next_task(p_task_type TEXT)
RETURNS SETOF agent_task_queue
LANGUAGE sql
AS $$
    UPDATE agent_task_queue
    SET status = 'claimed', claimed_at = now()
    WHERE id = (
        SELECT id FROM agent_task_queue
        WHERE task = p_task_type AND status = 'pending'
        ORDER BY priority ASC, created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
$$;

-- Generic SQL execution RPC (for tool use).
-- SECURITY NOTE: Only expose this if you trust the agent's tool-calling behavior.
-- Consider restricting with RLS or a restricted role for production.
CREATE OR REPLACE FUNCTION agent_execute_sql(sql_query TEXT)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    result JSONB;
BEGIN
    EXECUTE 'SELECT jsonb_agg(row_to_json(t)) FROM (' || sql_query || ') t' INTO result;
    RETURN COALESCE(result, '[]'::jsonb);
END;
$$;
