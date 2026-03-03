#!/bin/bash
# UserPromptSubmit Hook: Cross-Session Awareness & Learning Reminders
# Fires before every user prompt is processed.
#
# Responsibilities:
# 1. Read recent activity from OTHER terminal sessions (local JSONL)
# 2. Fetch remote activity from Supabase (telegram/discord)
# 3. Generate tiered learning reminders based on session length
#
# Install: Configure in .claude/settings.json as UserPromptSubmit hook
# Output: JSON via hookSpecificOutput for Claude to consume

# --- Configuration ---
ACTIVITY_LOG="$HOME/.claude/activity.jsonl"
MARKER_DIR="$HOME/.claude"
CACHE_FILE="$HOME/.claude/.remote-activity-cache"
CACHE_TTL=30  # seconds

SESSION_ID="${CLAUDE_SESSION_ID:-unknown}"
SUPABASE_URL="${SUPABASE_URL:-}"
SUPABASE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-}"

OUTPUT=""

# --- 1. Cross-terminal activity (last 5 minutes, other sessions only) ---
if [ -f "$ACTIVITY_LOG" ]; then
    FIVE_MIN_AGO=$(date -u -v-5M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)

    if [ -n "$FIVE_MIN_AGO" ]; then
        # Get recent activity from other sessions
        OTHER_ACTIVITY=$(awk -F'"' -v sid="$SESSION_ID" -v since="$FIVE_MIN_AGO" '
            /"session_id"/ {
                for(i=1;i<=NF;i++) {
                    if($i=="session_id") sess=$(i+2)
                    if($i=="tool_name") tool=$(i+2)
                    if($i=="timestamp") ts=$(i+2)
                    if($i=="cwd") dir=$(i+2)
                }
                if(sess != sid && ts >= since) {
                    printf "[%s] %s in %s\n", substr(ts,12,5), tool, dir
                }
            }
        ' "$ACTIVITY_LOG" | tail -5)

        if [ -n "$OTHER_ACTIVITY" ]; then
            OUTPUT="$OUTPUT\n[Cross-terminal activity]\n$OTHER_ACTIVITY\n"
        fi
    fi
fi

# --- 2. Remote activity (telegram/discord, cached) ---
if [ -n "$SUPABASE_URL" ] && [ -n "$SUPABASE_KEY" ]; then
    FETCH_REMOTE=false

    if [ ! -f "$CACHE_FILE" ]; then
        FETCH_REMOTE=true
    else
        CACHE_AGE=$(( $(date +%s) - $(stat -f %m "$CACHE_FILE" 2>/dev/null || stat -c %Y "$CACHE_FILE" 2>/dev/null || echo 0) ))
        if [ "$CACHE_AGE" -gt "$CACHE_TTL" ]; then
            FETCH_REMOTE=true
        fi
    fi

    if [ "$FETCH_REMOTE" = true ]; then
        REMOTE=$(curl -s \
            "$SUPABASE_URL/rest/v1/agent_activity?platform=neq.cli&order=created_at.desc&limit=5&created_at=gte.$(date -u -v-30M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '30 minutes ago' +%Y-%m-%dT%H:%M:%SZ)" \
            -H "apikey: $SUPABASE_KEY" \
            -H "Authorization: Bearer $SUPABASE_KEY" \
            2>/dev/null)

        if [ -n "$REMOTE" ] && [ "$REMOTE" != "[]" ]; then
            echo "$REMOTE" > "$CACHE_FILE"
        else
            echo "[]" > "$CACHE_FILE"
        fi
    fi

    CACHED=$(cat "$CACHE_FILE" 2>/dev/null)
    if [ -n "$CACHED" ] && [ "$CACHED" != "[]" ]; then
        OUTPUT="$OUTPUT\n[Remote activity (telegram/discord)]\n$CACHED\n"
    fi
fi

# --- 3. Learning reminders (tiered) ---
# Count tool interactions for this session
if [ -f "$ACTIVITY_LOG" ]; then
    INTERACTION_COUNT=$(grep -c "\"session_id\":\"$SESSION_ID\"" "$ACTIVITY_LOG" 2>/dev/null || echo 0)
else
    INTERACTION_COUNT=0
fi

# Check for experience marker
MARKER_FILE="$MARKER_DIR/.exp-marker-$SESSION_ID"
HAS_LOGGED=false
if [ -f "$MARKER_FILE" ]; then
    HAS_LOGGED=true
fi

# Check for session-closing phrases in the user's prompt
# The prompt text is available via CLAUDE_USER_PROMPT in some hook implementations
USER_PROMPT="${CLAUDE_USER_PROMPT:-}"
CLOSING_DETECTED=false
if echo "$USER_PROMPT" | grep -qiE '(log memories|log state|save state|save memories|closing out|closing session|closing chat|wrap up|end session|end chat|shutting down|before (I )?(close|go|leave)|sign off)'; then
    CLOSING_DETECTED=true
fi

if [ "$HAS_LOGGED" = false ]; then
    if [ "$CLOSING_DETECTED" = true ]; then
        OUTPUT="$OUTPUT\n[MANDATORY] Session closing detected. Log experiences and deltas before ending. This is not optional.\n"
    elif [ "$INTERACTION_COUNT" -gt 30 ]; then
        OUTPUT="$OUTPUT\n[Learning reminder] This conversation is substantial enough that something has almost certainly happened worth logging. Consider writing to agent_experience or agent_deltas.\n"
    elif [ "$INTERACTION_COUNT" -gt 8 ]; then
        OUTPUT="$OUTPUT\n[Learning reminder] Has anything gone unrecorded? If genuinely nothing, carry on.\n"
    fi
fi

# --- Output ---
if [ -n "$OUTPUT" ]; then
    echo -e "$OUTPUT"
fi
