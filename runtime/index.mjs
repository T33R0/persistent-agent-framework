/**
 * PAF Runtime — Public API
 *
 * Import from here for the full framework:
 *   import { MarkerEngine, DaemonRunner, assembleAgentPrompt } from './runtime/index.mjs';
 */

// Core
export { supabaseFetch, SUPABASE_URL, SUPABASE_KEY } from "./supabase-client.mjs";
export { env, validateConfig, CLAUDE_MODELS, GEMINI_MODELS, OPENAI_MODELS, OLLAMA_MODELS, TIMEOUTS, INTERVALS, LIMITS } from "./config.mjs";

// Marker processing
export { MarkerEngine, createDefaultEngine, extractMarkerJson, extractMarkerText, stripMarker } from "./marker-engine.mjs";

// Agent identity
export { assembleAgentPrompt, loadSoul, loadMemories, loadState, loadLedger, loadSessionHandoff, loadConversationHistory, saveConversation, saveMemory, upsertState } from "./agent-boot.mjs";
export { loadAgent, loadAgentById, updateAgent, resolveBotToken, getUserRole, isOwner, isCreator, isAuthorized, invalidateAgentCache } from "./agent-config.mjs";

// Sessions
export { AgentSessionManager } from "./session-manager.mjs";

// Memory
export { loadMemoriesHybrid, saveMemoryWithEmbedding, generateEmbedding } from "./semantic-memory.mjs";

// LLM
export { PROVIDERS, getAvailableProviders, DEFAULT_PROVIDER_ORDER, claudeChat, openaiChat, geminiChat, ollamaChat, scrubSecrets } from "./llm-providers.mjs";

// Tools
export { TOOL_DEFINITIONS, TOOL_EXECUTORS, executeTool, getTools, getToolPreset, TOOL_PRESETS, toClaudeTools, toOpenAITools, toGeminiTools, toOllamaTools } from "./tools.mjs";

// Daemon
export { DaemonRunner, createTaskSweep, createEmbeddingSweep } from "./daemon.mjs";

// Onboarding
export { buildOnboardingPrompt, parseOnboardingResponse, advanceOnboarding, resetOnboarding } from "./onboarding.mjs";
