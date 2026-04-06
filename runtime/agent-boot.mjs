/**
 * PAF Agent Boot — System prompt assembly from persistent state.
 *
 * Loads soul directives, memories, state, ledger, session context,
 * and conversation history — then assembles them into a system prompt
 * with token budget awareness.
 *
 * This is the core of what makes a PAF agent persistent. Every boot
 * loads the agent's accumulated identity, knowledge, and learnings.
 */

import { supabaseFetch } from "./supabase-client.mjs";

// ── Data loaders ─────────────────────────────────────────────

/**
 * Load active soul directives, ordered by priority.
 * @param {string} agentId
 * @returns {Promise<Array<{directive: string, category: string, priority: number}>>}
 */
export async function loadSoul(agentId) {
  const res = await supabaseFetch(
    `/rest/v1/agent_soul?active=is.true&order=priority.desc`
  );
  return await res.json();
}

/**
 * Load top memories by importance.
 * @param {string} agentId
 * @param {number} limit
 * @returns {Promise<Array<{content: string, context: string, category: string, importance: number}>>}
 */
export async function loadMemories(agentId, limit = 15) {
  const res = await supabaseFetch(
    `/rest/v1/agent_memory?order=importance.desc&limit=${limit}`
  );
  return await res.json();
}

/**
 * Load agent state (key-value pairs).
 * @param {string} agentId
 * @returns {Promise<Record<string, any>>}
 */
export async function loadState(agentId) {
  const res = await supabaseFetch(`/rest/v1/agent_state`);
  const rows = await res.json();
  const state = {};
  for (const row of rows) state[row.key] = row.value;
  return state;
}

/**
 * Load conversation history for a platform/user, with markers stripped.
 * @param {string} agentId
 * @param {string} platform
 * @param {string} userId
 * @param {number} limit
 * @param {Function} [stripFn] — Optional function to strip markers from assistant messages
 * @returns {Promise<Array<{role: string, content: string, metadata: object, created_at: string}>>}
 */
export async function loadConversationHistory(agentId, platform, userId, limit = 20, stripFn = null) {
  const res = await supabaseFetch(
    `/rest/v1/agent_conversations?platform=eq.${platform}&platform_user_id=eq.${userId}` +
      `&order=created_at.desc&limit=${limit}&select=role,content,metadata,created_at`
  );
  const rows = await res.json();
  return rows.reverse().map((r) => ({
    role: r.role,
    content: r.role === "assistant" && stripFn ? stripFn(r.content) : r.content,
    metadata: r.metadata || {},
    created_at: r.created_at,
  }));
}

/**
 * Save a conversation turn.
 */
export async function saveConversation(agentId, platform, userId, role, content, metadata = {}) {
  await supabaseFetch("/rest/v1/agent_conversations", {
    method: "POST",
    body: JSON.stringify({
      agent_id: agentId,
      platform,
      platform_user_id: String(userId),
      role,
      content,
      metadata,
    }),
  });
}

/**
 * Upsert an agent state key-value pair.
 */
export async function upsertState(agentId, key, value) {
  await supabaseFetch("/rest/v1/agent_state?on_conflict=key", {
    method: "POST",
    headers: { Prefer: "return=representation,resolution=merge-duplicates" },
    body: JSON.stringify({
      key,
      value: typeof value === "string" ? JSON.parse(value) : value,
      updated_at: new Date().toISOString(),
    }),
  });
}

/**
 * Save a memory.
 */
export async function saveMemory(agentId, content, context, category = "general", importance = 50) {
  await supabaseFetch("/rest/v1/agent_memory", {
    method: "POST",
    body: JSON.stringify({ content, context, category, importance }),
  });
}

/**
 * Load recent ledger entries (wins + mistakes).
 */
export async function loadLedger(agentId, limit = 10) {
  const res = await supabaseFetch(
    `/rest/v1/agent_ledger?status=eq.active&order=created_at.desc&limit=${limit}`
  );
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/**
 * Load latest session handoff.
 */
export async function loadSessionHandoff(agentId) {
  const res = await supabaseFetch(
    `/rest/v1/agent_session_handoff?order=created_at.desc&limit=1`
  );
  const data = await res.json();
  return Array.isArray(data) && data.length ? data[0] : null;
}

// ── System prompt assembly ───────────────────────────────────

/**
 * Assemble a full system prompt for an agent from all persistent sources.
 *
 * @param {object} agent — Agent config: { id, agent_name, owner_name, timezone, ... }
 * @param {object} opts
 * @param {boolean} [opts.includeMemories=true]
 * @param {string}  [opts.contextHint] — User's message, for semantic memory search
 * @param {boolean} [opts.isResume=false] — True if same-day continuation
 * @param {string}  [opts.platform] — 'telegram', 'discord', 'web'
 * @param {Function} [opts.loadMemoriesFn] — Custom memory loader (e.g. hybrid semantic search)
 * @param {string[]} [opts.extraSections] — Additional prompt sections to append
 * @returns {Promise<string>}
 */
export async function assembleAgentPrompt(agent, opts = {}) {
  const {
    includeMemories = true,
    contextHint,
    isResume = false,
    platform,
    loadMemoriesFn,
    extraSections = [],
  } = opts;

  const parts = [];
  const tz = agent.timezone || "America/Denver";

  // ── Parallel load all data sources ──
  const memoryLoader = !includeMemories
    ? Promise.resolve([])
    : loadMemoriesFn
      ? loadMemoriesFn(agent.id, contextHint)
      : loadMemories(agent.id);

  const [soul, memories, state, ledger, handoff] = await Promise.all([
    loadSoul(agent.id),
    memoryLoader,
    loadState(agent.id),
    loadLedger(agent.id, 10),
    loadSessionHandoff(agent.id),
  ]);

  // ── Date/time header (authoritative — prevents LLM date hallucination) ──
  const dateStr = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: tz,
  });
  const timeStr = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  });
  parts.push(
    `## TODAY: ${dateStr} — ${timeStr}\n` +
      `This is your AUTHORITATIVE date and time. Do NOT calculate or infer a different date. ` +
      `All references to "today", "yesterday", "this morning" etc. are relative to THIS date.`
  );

  // ── Identity ──
  if (agent.agent_name) {
    parts.push(`\nYou are ${agent.agent_name} — a personal AI companion for ${agent.owner_name}.`);
  } else {
    parts.push(`\nYou are a personal AI companion for ${agent.owner_name}.`);
  }

  if (isResume) {
    parts.push(
      `\n[RESUMED SESSION — your personality, directives, and knowledge are already loaded from earlier today. This is a continuation.]`
    );
  }

  // ── Soul directives (deduplicated at prompt level) ──
  if (soul.length) {
    parts.push("\n## Your Personality & Directives");
    const seen = new Set();
    for (const s of soul) {
      const normalized = s.directive.trim().toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      parts.push(`- ${s.directive}`);
    }
  }

  // ── Memories ──
  if (memories.length) {
    parts.push(`\n## What You Know About ${agent.owner_name}`);
    for (const m of memories) {
      parts.push(`- ${m.content}${m.context ? ` (${m.context})` : ""}`);
    }
  }

  // ── State ──
  const stateLines = [];
  if (state.emotional_state) {
    const es = state.emotional_state;
    stateLines.push(
      `Your current emotional state: ${es.state}${es.trigger ? ` (trigger: ${es.trigger})` : ""}`
    );
  }
  if (state.ongoing_threads?.threads?.length) {
    stateLines.push(
      `Ongoing threads: ${state.ongoing_threads.threads.map((t) => t.topic).join(", ")}`
    );
  }
  if (state.owner_context) {
    const oc = state.owner_context;
    if (oc.mood) stateLines.push(`${agent.owner_name}'s recent mood: ${oc.mood}`);
    if (oc.recent_topics?.length)
      stateLines.push(`Recent topics: ${oc.recent_topics.join(", ")}`);
  }
  if (stateLines.length) {
    parts.push(`\n## Current State\n${stateLines.join("\n")}`);
  }

  // ── Session handoff (what happened last session) ──
  if (handoff) {
    const handoffLines = ["\n## Last Session"];
    const date = new Date(handoff.created_at).toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    handoffLines.push(`(${date}, ${handoff.message_count || "?"} messages)`);
    if (handoff.active_topics) handoffLines.push(`Topics: ${handoff.active_topics}`);
    if (handoff.open_threads) handoffLines.push(`Open threads: ${handoff.open_threads}`);
    if (handoff.next_session_context)
      handoffLines.push(`Context for today: ${handoff.next_session_context}`);
    parts.push(handoffLines.join("\n"));
  }

  // ── Ledger (recent wins and mistakes) ──
  if (ledger.length) {
    const wins = ledger.filter((e) => e.entry_type === "win");
    const mistakes = ledger.filter((e) => e.entry_type === "mistake");
    const ledgerLines = ["\n## Recent Learnings"];
    if (wins.length) {
      ledgerLines.push("**What went well:**");
      for (const w of wins.slice(0, 5)) ledgerLines.push(`- ${w.what}`);
    }
    if (mistakes.length) {
      ledgerLines.push("**What to improve:**");
      for (const m of mistakes.slice(0, 5)) {
        ledgerLines.push(
          `- ${m.what}${m.should_have ? ` → should have: ${m.should_have}` : ""}`
        );
      }
    }
    parts.push(ledgerLines.join("\n"));
  }

  // ── Marker instructions ──
  parts.push(`
## Markers (invisible to user)
When something important happens in conversation, emit markers to persist it.
Markers are stripped before the user sees your response — they are infrastructure.

Available markers:
- [MEMORY]{"content": "what to remember", "context": "why", "category": "general", "importance": 0.7}
- [STATE]{"key": "owner_context", "value": {"mood": "upbeat", "recent_topics": ["topic1"]}}
- [WIN]{"what": "what went well"}
- [MISTAKE]{"what": "what went wrong", "should_have": "what you should have done", "pattern": "pattern_name"}
- [JOURNAL]{"entry": "reflection text", "mood": "reflective"}
- [STYLE_FEEDBACK]{"directive": "be more concise", "category": "style"}

Rules:
- NEVER mention markers, tools, or internal processes to the user.
- Emit markers silently — don't narrate ("let me save that...").
- Save memories when you learn something worth remembering across sessions.
- Log mistakes when you get corrected. Log wins when you handle something well.
- Update state when the user's mood, context, or ongoing threads change.`);

  // ── Extra sections (domain-specific, caller-provided) ──
  for (const section of extraSections) {
    parts.push(section);
  }

  return parts.join("\n");
}
