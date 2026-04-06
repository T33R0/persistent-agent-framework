#!/usr/bin/env node
/**
 * Example PAF Daemon Entry Point
 *
 * This is a working example of a daemon that:
 * 1. Processes conversation tasks from the queue (web/telegram messages)
 * 2. Handles proactive messaging (scheduled check-ins)
 * 3. Generates embeddings for new memories
 *
 * Copy this file, customize the handler functions, and run via launchd.
 *
 * Usage:
 *   node daemon-entry.mjs --agent my-agent-slug
 *
 * Environment variables required:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY (or other LLM key)
 */

import {
  DaemonRunner,
  createTaskSweep,
  createEmbeddingSweep,
  loadAgent,
  assembleAgentPrompt,
  loadConversationHistory,
  saveConversation,
  MarkerEngine,
  createDefaultEngine,
  saveMemory,
  upsertState,
  PROVIDERS,
  DEFAULT_PROVIDER_ORDER,
  getAvailableProviders,
  generateEmbedding,
  validateConfig,
} from "../runtime/index.mjs";

// ── Parse args ───────────────────────────────────────────────
const agentSlug = process.argv.includes("--agent")
  ? process.argv[process.argv.indexOf("--agent") + 1]
  : "default";

// ── Validate environment ─────────────────────────────────────
validateConfig(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"], "daemon");

// ── Build marker engine with persistence callbacks ───────────
function buildMarkerEngine(agentId) {
  return createDefaultEngine({
    saveMemory: async (data) => {
      await saveMemory(agentId, data.content, data.context, data.category || "general", data.importance || 50);
      console.log(`[daemon] Saved memory: ${data.content.substring(0, 60)}...`);
    },
    upsertState: async (data) => {
      await upsertState(agentId, data.key, data.value);
      console.log(`[daemon] Updated state: ${data.key}`);
    },
    logWin: async (data) => {
      const { supabaseFetch } = await import("../runtime/supabase-client.mjs");
      await supabaseFetch("/rest/v1/agent_ledger", {
        method: "POST",
        body: JSON.stringify({
          entry_type: "win",
          what: data.what,
          why: data.why || null,
          status: "active",
        }),
      });
      console.log(`[daemon] Logged win: ${data.what}`);
    },
    logMistake: async (data) => {
      const { supabaseFetch } = await import("../runtime/supabase-client.mjs");
      await supabaseFetch("/rest/v1/agent_ledger", {
        method: "POST",
        body: JSON.stringify({
          entry_type: "mistake",
          what: data.what,
          why: data.why || null,
          should_have: data.should_have || null,
          pattern: data.pattern || null,
          status: "active",
        }),
      });
      console.log(`[daemon] Logged mistake: ${data.what}`);
    },
    saveJournal: async (data) => {
      // Implement journal persistence for your use case
      console.log(`[daemon] Journal entry: ${data.entry?.substring(0, 60)}...`);
    },
    onStyleFeedback: async (data) => {
      const { supabaseFetch } = await import("../runtime/supabase-client.mjs");
      await supabaseFetch("/rest/v1/agent_soul", {
        method: "POST",
        body: JSON.stringify({
          directive: data.directive,
          category: data.category || "style",
          priority: 80,
          active: true,
          source: "style_feedback",
        }),
      });
      console.log(`[daemon] Style feedback saved: ${data.directive}`);
    },
  });
}

// ── Get first available LLM provider ─────────────────────────
function getProvider() {
  const available = getAvailableProviders();
  if (available.length === 0) throw new Error("No LLM providers available");
  const name = DEFAULT_PROVIDER_ORDER.find((p) => available.includes(p));
  return PROVIDERS[name || available[0]];
}

// ── Conversation handler ─────────────────────────────────────
async function handleConversation(task) {
  const agent = await loadAgent(agentSlug);
  const { platform, platform_user_id: userId } = task.payload;

  // Load conversation history
  const history = await loadConversationHistory(agent.id, platform, userId, 20);
  const messages = history.map((m) => ({ role: m.role, content: m.content }));

  // Assemble system prompt
  const systemPrompt = await assembleAgentPrompt(agent, {
    contextHint: messages[messages.length - 1]?.content,
    platform,
  });

  // Call LLM
  const provider = getProvider();
  const response = await provider.chat(systemPrompt, messages, {
    maxTokens: 4096,
    timeout: 120000,
  });

  // Process markers
  const markerEngine = buildMarkerEngine(agent.id);
  const { cleanText } = await markerEngine.process(response.text);

  // Save assistant response
  await saveConversation(agent.id, platform, userId, "assistant", cleanText, {
    model: response.usage.model,
    tokens: response.usage.outputTokens,
  });

  console.log(
    `[daemon] Replied on ${platform} (${response.usage.model}, ${response.usage.outputTokens} tokens)`
  );
}

// ── Start daemon ─────────────────────────────────────────────
async function main() {
  const agent = await loadAgent(agentSlug);
  console.log(`[daemon] Starting for agent: ${agent.agent_name || agent.agent_slug}`);

  const daemon = new DaemonRunner(agentSlug, {
    healthIntervalMs: 30000,
    maxConsecutiveFailures: 3,
  });

  // Sweep: process conversation tasks (web + telegram)
  daemon.addSweep(
    "conversations",
    createTaskSweep("web_conversation", handleConversation),
    { intervalMs: 10000 }
  );

  // Sweep: generate embeddings for new memories
  daemon.addSweep(
    "embeddings",
    createEmbeddingSweep(generateEmbedding, { batchSize: 5 }),
    { intervalMs: 60000 }
  );

  daemon.start();
}

main().catch((err) => {
  console.error("[daemon] Fatal:", err);
  process.exit(1);
});
