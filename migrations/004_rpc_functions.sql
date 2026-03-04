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

-- Hybrid memory loading: importance-ranked + semantic similarity
-- Boot loads top N by importance (always-available critical context).
-- Per-task loads top M by cosine similarity to the current query embedding.
-- Results are deduplicated (similarity pool excludes importance pool).
CREATE OR REPLACE FUNCTION hybrid_memory_load(
    p_query_embedding vector,
    p_importance_limit INTEGER DEFAULT 5,
    p_similarity_limit INTEGER DEFAULT 10
)
RETURNS TABLE(
    id UUID,
    key TEXT,
    content TEXT,
    category TEXT,
    importance INTEGER,
    tags TEXT[],
    source TEXT,
    similarity FLOAT
)
LANGUAGE sql STABLE
AS $$
    WITH by_importance AS (
        SELECT
            m.id, m.key, m.content, m.category, m.importance, m.tags,
            'importance'::TEXT as source,
            0.0::FLOAT as similarity
        FROM agent_memory m
        ORDER BY m.importance DESC
        LIMIT p_importance_limit
    ),
    by_similarity AS (
        SELECT
            m.id, m.key, m.content, m.category, m.importance, m.tags,
            'similarity'::TEXT as source,
            (1 - (m.embedding <=> p_query_embedding))::FLOAT as similarity
        FROM agent_memory m
        WHERE m.embedding IS NOT NULL
            AND m.id NOT IN (SELECT bi.id FROM by_importance bi)
        ORDER BY m.embedding <=> p_query_embedding
        LIMIT p_similarity_limit
    )
    SELECT * FROM by_importance
    UNION ALL
    SELECT * FROM by_similarity
    ORDER BY source, importance DESC;
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
