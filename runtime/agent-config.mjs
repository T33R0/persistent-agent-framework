/**
 * PAF Agent Configuration
 *
 * Loads agent config from Supabase, resolves runtime settings,
 * and provides role-checking helpers.
 *
 * Each agent has a row in agent_config with:
 *   - agent_slug: short identifier (e.g. "lee", "buddy")
 *   - agent_name: display name
 *   - owner_name: who the agent serves
 *   - owner_telegram_id / creator_telegram_id: for authorization
 *   - config: JSON blob with runtime settings
 *   - timezone: IANA timezone
 *   - onboarding_complete: boolean
 *   - onboarding_step: 0-5
 *   - status: 'pending_onboarding' | 'onboarding' | 'active'
 */

import { supabaseFetch } from "./supabase-client.mjs";

// ── Cache ────────────────────────────────────────────────────
let agentCache = {};
const CACHE_TTL = 60_000; // 1 min

// ── Load agent by slug ───────────────────────────────────────

export async function loadAgent(slug) {
  const now = Date.now();
  if (agentCache[slug] && now - agentCache[slug]._ts < CACHE_TTL) {
    return agentCache[slug];
  }

  const res = await supabaseFetch(
    `/rest/v1/agent_config?agent_slug=eq.${slug}&limit=1`
  );
  const data = await res.json();
  if (!data.length) throw new Error(`Agent not found: ${slug}`);

  const agent = data[0];
  agent._ts = now;
  agentCache[slug] = agent;
  return agent;
}

// ── Load agent by ID ─────────────────────────────────────────

export async function loadAgentById(id) {
  const res = await supabaseFetch(`/rest/v1/agent_config?id=eq.${id}&limit=1`);
  const data = await res.json();
  if (!data.length) throw new Error(`Agent not found: ${id}`);
  return data[0];
}

// ── Resolve platform bot token from env ──────────────────────

export function resolveBotToken(agent, platform = "telegram") {
  const envKey = agent.config?.[`${platform}_bot_token_env`];
  if (!envKey)
    throw new Error(`No ${platform}_bot_token_env in agent config for ${agent.agent_slug}`);
  const token = process.env[envKey];
  if (!token) throw new Error(`Missing env var: ${envKey}`);
  return token;
}

// ── Role checking ────────────────────────────────────────────

export function getUserRole(agent, platformUserId) {
  const uid = String(platformUserId);
  if (uid === String(agent.creator_telegram_id)) return "creator";
  if (uid === String(agent.owner_telegram_id)) return "owner";
  return "unknown";
}

export function isOwner(agent, platformUserId) {
  return getUserRole(agent, platformUserId) === "owner";
}

export function isCreator(agent, platformUserId) {
  return getUserRole(agent, platformUserId) === "creator";
}

export function isAuthorized(agent, platformUserId) {
  const role = getUserRole(agent, platformUserId);
  return role === "owner" || role === "creator";
}

// ── Update agent record ──────────────────────────────────────

export async function updateAgent(agentId, fields) {
  const res = await supabaseFetch(`/rest/v1/agent_config?id=eq.${agentId}`, {
    method: "PATCH",
    body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }),
  });
  // Invalidate cache
  for (const key of Object.keys(agentCache)) {
    if (agentCache[key]?.id === agentId) delete agentCache[key];
  }
  return res;
}

// ── Invalidate cache ─────────────────────────────────────────

export function invalidateAgentCache(slug) {
  if (slug) delete agentCache[slug];
  else agentCache = {};
}
