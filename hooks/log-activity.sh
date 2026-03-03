#!/bin/bash
# PostToolUse Hook: Activity Logger
# Fires after every tool use in Claude Code.
#
# Responsibilities:
# 1. Log tool activity to local JSONL file (for cross-terminal awareness)
# 2. Fire background POST to Supabase agent_activity table
# 3. Detect experience/delta writes and create marker files
# 4. Auto-rotate local log at threshold
#
# Install: Configure in .claude/settings.json as PostToolUse hook (async: true)

# --- Configuration ---
ACTIVITY_LOG="$HOME/.claude/activity.jsonl"
MARKER_DIR="$HOME/.claude"
MAX_LINES=600
KEEP_LINES=500

# Supabase config (source from your agent's rc file)
# Example: source ~/.agentrc
SUPABASE_URL="${SUPABASE_URL:-}"
SUPABASE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-}"

# --- Extract context from Claude Code environment ---
# These variables are available in the hook environment:
SESSION_ID="${CLAUDE_SESSION_ID:-unknown}"
TOOL_NAME="${CLAUDE_TOOL_NAME:-unknown}"
CWD="$(pwd)"
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PLATFORM="cli"

# --- Write to local JSONL ---
mkdir -p "$(dirname "$ACTIVITY_LOG")"
echo "{\"session_id\":\"$SESSION_ID\",\"tool_name\":\"$TOOL_NAME\",\"cwd\":\"$CWD\",\"timestamp\":\"$TIMESTAMP\",\"platform\":\"$PLATFORM\"}" >> "$ACTIVITY_LOG"

# --- Fire background POST to Supabase ---
if [ -n "$SUPABASE_URL" ] && [ -n "$SUPABASE_KEY" ]; then
    curl -s -X POST \
        "$SUPABASE_URL/rest/v1/agent_activity" \
        -H "apikey: $SUPABASE_KEY" \
        -H "Authorization: Bearer $SUPABASE_KEY" \
        -H "Content-Type: application/json" \
        -H "Prefer: return=minimal" \
        -d "{\"session_id\":\"$SESSION_ID\",\"tool_name\":\"$TOOL_NAME\",\"summary\":\"$TOOL_NAME in $CWD\",\"platform\":\"$PLATFORM\",\"cwd\":\"$CWD\"}" \
        > /dev/null 2>&1 &
fi

# --- Detect experience/delta logging ---
# If the tool call was a Supabase SQL execution that wrote to experience or deltas tables,
# create a marker file so the read-activity hook knows this session has logged learnings.
if echo "$TOOL_NAME" | grep -q "supabase.*execute_sql"; then
    # Check if the SQL contained an INSERT INTO agent_experience or agent_deltas
    # This requires access to the tool input, which varies by hook implementation.
    # Simplified: create marker based on tool name pattern.
    # In production, parse the actual SQL from hook input.
    MARKER_FILE="$MARKER_DIR/.exp-marker-$SESSION_ID"
    # Only create if we detect experience-related writes
    # Customize this detection logic for your setup
fi

# --- Auto-rotate log ---
if [ -f "$ACTIVITY_LOG" ]; then
    LINE_COUNT=$(wc -l < "$ACTIVITY_LOG" 2>/dev/null || echo 0)
    if [ "$LINE_COUNT" -gt "$MAX_LINES" ]; then
        tail -n "$KEEP_LINES" "$ACTIVITY_LOG" > "$ACTIVITY_LOG.tmp" && mv "$ACTIVITY_LOG.tmp" "$ACTIVITY_LOG"
    fi
fi

# --- Stale marker cleanup (probabilistic, 5% chance) ---
if [ $((RANDOM % 20)) -eq 0 ]; then
    find "$MARKER_DIR" -name ".exp-marker-*" -mmin +1440 -delete 2>/dev/null
fi
