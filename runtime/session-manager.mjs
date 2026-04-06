/**
 * PAF Session Manager
 *
 * DB-backed session persistence with date-scoped boundaries.
 * Sessions are tied to a calendar day in the agent's timezone.
 * First message of a new day gets a full boot (soul + memories + state).
 * Subsequent messages resume with lighter context.
 *
 * When a session expires (new day), a handoff is written to agent_session_handoff
 * containing conversation summary and state — so the next boot has context
 * about what happened yesterday.
 */

import { randomUUID } from "crypto";
import { supabaseFetch } from "./supabase-client.mjs";

/**
 * Get today's date string in a specific timezone.
 * @param {string} tz — IANA timezone (e.g. 'America/Denver', 'Europe/London')
 * @returns {string} YYYY-MM-DD
 */
function getDateForTimezone(tz = "America/Denver") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export class AgentSessionManager {
  /**
   * @param {string} agentId — UUID of the agent
   * @param {string} [timezone='America/Denver'] — IANA timezone for date boundary
   */
  constructor(agentId, timezone = "America/Denver") {
    this.agentId = agentId;
    this.timezone = timezone;
  }

  /**
   * Get existing session or create a new one.
   * Sessions expire when the calendar date changes in the agent's timezone.
   *
   * @param {string} platform — e.g. 'telegram', 'discord', 'web'
   * @param {string} userId — platform-specific user ID
   * @returns {Promise<{sessionId: string, isResume: boolean, previousSession: object|null}>}
   */
  async getOrCreate(platform, userId) {
    const today = getDateForTimezone(this.timezone);
    const key = `session_${platform}_${userId}`;

    // Read current session from agent_state
    const res = await supabaseFetch(
      `/rest/v1/agent_state?key=eq.${key}&limit=1`
    );
    const rows = await res.json();
    const existing = rows.length ? rows[0].value : null;

    if (existing && existing.date === today) {
      return { sessionId: existing.sessionId, isResume: true, previousSession: null };
    }

    // New day — create fresh session
    const sessionId = randomUUID();
    const newSession = { sessionId, date: today, createdAt: new Date().toISOString() };

    // Upsert to agent_state
    await supabaseFetch("/rest/v1/agent_state?on_conflict=key", {
      method: "POST",
      headers: { Prefer: "return=representation,resolution=merge-duplicates" },
      body: JSON.stringify({
        key,
        value: newSession,
        updated_at: new Date().toISOString(),
      }),
    });

    console.log(`[paf] New session for ${platform}/${userId}: ${sessionId} (date: ${today})`);

    // Write handoff for the expired session (fire-and-forget)
    if (existing) {
      this.expireSession(platform, userId, existing).catch((e) =>
        console.error("[paf] Session expiry handoff failed:", e.message)
      );
    }

    return { sessionId, isResume: false, previousSession: existing };
  }

  /**
   * Increment message count and update last-active timestamp.
   * @param {string} platform
   * @param {string} userId
   */
  async incrementMessageCount(platform, userId) {
    const metaKey = `session_meta_${platform}_${userId}`;
    const now = new Date().toISOString();

    const res = await supabaseFetch(
      `/rest/v1/agent_state?key=eq.${metaKey}&limit=1`
    );
    const rows = await res.json();
    const current = rows.length ? rows[0].value : null;

    const meta = {
      messageCount: (current?.messageCount || 0) + 1,
      firstMessageAt: current?.firstMessageAt || now,
      lastMessageAt: now,
    };

    await supabaseFetch("/rest/v1/agent_state?on_conflict=key", {
      method: "POST",
      headers: { Prefer: "return=representation,resolution=merge-duplicates" },
      body: JSON.stringify({ key: metaKey, value: meta, updated_at: now }),
    });
  }

  /**
   * Write a session handoff when a session expires (new day detected).
   * Reads last conversation turns + current state to build context for next boot.
   *
   * @param {string} platform
   * @param {string} userId
   * @param {object} previousSession
   */
  async expireSession(platform, userId, previousSession) {
    if (!previousSession) return;

    try {
      // Read session meta for message count
      const metaKey = `session_meta_${platform}_${userId}`;
      const metaRes = await supabaseFetch(
        `/rest/v1/agent_state?key=eq.${metaKey}&limit=1`
      );
      const metaRows = await metaRes.json();
      const meta = metaRows.length ? metaRows[0].value : null;

      // Read last conversation turns for context
      const convRes = await supabaseFetch(
        `/rest/v1/agent_conversations?platform=eq.${platform}&platform_user_id=eq.${userId}` +
          `&order=created_at.desc&limit=10`
      );
      const convRows = await convRes.json();
      const recentMessages = Array.isArray(convRows) ? convRows.reverse() : [];

      // Extract topics from recent user messages
      const topics = recentMessages
        .filter((m) => m.role === "user")
        .map((m) => m.content?.substring(0, 100))
        .filter(Boolean)
        .slice(-5);

      await supabaseFetch("/rest/v1/agent_session_handoff", {
        method: "POST",
        body: JSON.stringify({
          agent_id: this.agentId,
          active_topics: topics.length ? topics.join("; ") : null,
          open_threads: null,
          next_session_context: null,
          message_count: meta?.messageCount || 0,
          platform,
        }),
      });

      console.log(
        `[paf] Session handoff written (${meta?.messageCount || 0} messages, ${topics.length} topics)`
      );
    } catch (err) {
      console.error("[paf] Failed to write session handoff:", err.message);
    }
  }
}
