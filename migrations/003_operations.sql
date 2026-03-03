-- Persistent Agent Framework: Operations Tables
-- Apply after 002_activity_tables.sql

-- Action item category enum
DO $$ BEGIN
    CREATE TYPE action_category AS ENUM (
        -- Meta
        'pending_triage',
        'filtered',
        -- Internal (safe for autonomous execution)
        'research',
        'analysis',
        'schema_change',
        'file_operation',
        'documentation',
        'test',
        'build',
        'refactor',
        'bugfix',
        -- External (require human approval)
        'api_call',
        'deployment',
        'communication',
        'financial',
        'user_facing',
        'integration'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Action items extracted from conversations
CREATE TABLE IF NOT EXISTS agent_action_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source TEXT NOT NULL,
    source_session_id TEXT,
    source_channel TEXT,
    raw_text TEXT NOT NULL,
    category action_category NOT NULL DEFAULT 'pending_triage',
    plan TEXT,
    estimated_impact TEXT,
    filter_reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    approved_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Inter-agent communication
CREATE TABLE IF NOT EXISTS agent_directives (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_agent TEXT NOT NULL,
    target_agent TEXT NOT NULL,
    directive_type TEXT NOT NULL CHECK (directive_type IN ('instruction', 'config', 'query', 'broadcast')),
    priority INTEGER DEFAULT 3,
    payload JSONB,
    status TEXT DEFAULT 'pending',
    claimed_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    result JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Claude usage tracking (optional, for cost monitoring)
CREATE TABLE IF NOT EXISTS agent_claude_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    platform TEXT,
    session_type TEXT,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    duration_ms INTEGER,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_action_items_status ON agent_action_items (status);
CREATE INDEX IF NOT EXISTS idx_action_items_category ON agent_action_items (category);
CREATE INDEX IF NOT EXISTS idx_directives_target ON agent_directives (target_agent, status);
CREATE INDEX IF NOT EXISTS idx_directives_status ON agent_directives (status);
CREATE INDEX IF NOT EXISTS idx_usage_platform ON agent_claude_usage (platform);
CREATE INDEX IF NOT EXISTS idx_usage_created ON agent_claude_usage (created_at DESC);
