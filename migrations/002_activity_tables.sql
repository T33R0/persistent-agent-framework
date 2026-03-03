-- Persistent Agent Framework: Activity & Learning Tables
-- Apply after 001_core_tables.sql

-- Cross-session activity awareness
CREATE TABLE IF NOT EXISTS agent_activity (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id TEXT,
    tool_name TEXT,
    summary TEXT,
    platform TEXT,
    cwd TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Experience log
CREATE TABLE IF NOT EXISTS agent_experience (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    context TEXT,
    experience TEXT,
    what_learned TEXT,
    category TEXT,
    confidence NUMERIC,
    session_id TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Expectation vs. reality tracking
CREATE TABLE IF NOT EXISTS agent_deltas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prediction TEXT,
    outcome TEXT,
    magnitude TEXT,
    confidence_before NUMERIC,
    confidence_after NUMERIC,
    surprise_signal TEXT,
    experience_id UUID REFERENCES agent_experience(id),
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Identity evolution changelog
CREATE TABLE IF NOT EXISTS agent_growth_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    change_type TEXT,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_activity_session ON agent_activity (session_id);
CREATE INDEX IF NOT EXISTS idx_activity_created ON agent_activity (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_platform ON agent_activity (platform);
CREATE INDEX IF NOT EXISTS idx_experience_category ON agent_experience (category);
CREATE INDEX IF NOT EXISTS idx_deltas_experience ON agent_deltas (experience_id);
