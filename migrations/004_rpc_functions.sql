-- Persistent Agent Framework: RPC Functions
-- Apply after 003_operations.sql
-- These enable atomic operations for multi-process safety.

-- Atomic heartbeat task claiming
-- Prevents duplicate processing when multiple bots/daemons run simultaneously
CREATE OR REPLACE FUNCTION claim_heartbeat_task(p_task_id UUID, p_claimer TEXT)
RETURNS BOOLEAN
LANGUAGE sql
AS $$
    UPDATE agent_heartbeat
    SET status = 'claimed', created_by_session = p_claimer, updated_at = now()
    WHERE id = p_task_id AND status = 'pending'
    RETURNING true;
$$;

-- Atomic directive claiming
-- Returns all pending directives for an agent and marks them as claimed in one operation
CREATE OR REPLACE FUNCTION claim_agent_directives(p_agent_name TEXT)
RETURNS SETOF agent_directives
LANGUAGE sql
AS $$
    UPDATE agent_directives
    SET status = 'claimed', claimed_at = now()
    WHERE target_agent = p_agent_name AND status = 'pending'
    RETURNING *;
$$;

-- Upsert memory (insert or update by key)
-- Use this instead of separate SELECT + INSERT/UPDATE to avoid race conditions
CREATE OR REPLACE FUNCTION upsert_memory(
    p_key TEXT,
    p_content TEXT,
    p_category TEXT DEFAULT NULL,
    p_tags TEXT[] DEFAULT NULL,
    p_importance INTEGER DEFAULT 50,
    p_source_session TEXT DEFAULT NULL
)
RETURNS agent_memory
LANGUAGE sql
AS $$
    INSERT INTO agent_memory (key, content, category, tags, importance, source_session)
    VALUES (p_key, p_content, p_category, p_tags, p_importance, p_source_session)
    ON CONFLICT (key) DO UPDATE SET
        content = EXCLUDED.content,
        category = COALESCE(EXCLUDED.category, agent_memory.category),
        tags = COALESCE(EXCLUDED.tags, agent_memory.tags),
        importance = EXCLUDED.importance,
        source_session = EXCLUDED.source_session,
        updated_at = now(),
        embedding = NULL,
        embedded_at = NULL
    RETURNING *;
$$;

-- Count pattern occurrences in ledger (for auto-promotion logic)
CREATE OR REPLACE FUNCTION count_pattern_occurrences(p_pattern TEXT)
RETURNS INTEGER
LANGUAGE sql
AS $$
    SELECT COUNT(*)::INTEGER
    FROM agent_ledger
    WHERE pattern = p_pattern AND entry_type = 'mistake' AND status = 'active';
$$;

-- Get unembedded records (for nightly vectorization job)
CREATE OR REPLACE FUNCTION get_unembedded_memories(p_limit INTEGER DEFAULT 50)
RETURNS SETOF agent_memory
LANGUAGE sql
AS $$
    SELECT * FROM agent_memory
    WHERE embedding IS NULL
    ORDER BY importance DESC
    LIMIT p_limit;
$$;

CREATE OR REPLACE FUNCTION get_unembedded_ledger(p_limit INTEGER DEFAULT 50)
RETURNS SETOF agent_ledger
LANGUAGE sql
AS $$
    SELECT * FROM agent_ledger
    WHERE embedding IS NULL
    ORDER BY created_at DESC
    LIMIT p_limit;
$$;
