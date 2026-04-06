/**
 * PAF Configuration — Single Source of Truth
 *
 * All shared constants, env vars, and model definitions live here.
 * Services import from this file instead of defining their own copies.
 *
 * Environment variables are loaded from your shell profile or a .env file
 * sourced by launchd plists. Call validateConfig() at service startup
 * to catch missing vars early.
 */

// ============================================================================
// ENVIRONMENT VARIABLES
// ============================================================================

export const env = {
  // Supabase
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,

  // Messaging (optional — set the ones you use)
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,

  // LLM API Keys (optional — provider cascade skips unavailable ones)
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  OLLAMA_URL: process.env.OLLAMA_URL || "http://localhost:11434",
};

// ============================================================================
// MODEL DEFINITIONS (canonical — all providers reference these)
// ============================================================================

// Map tier names (opus/sonnet/haiku) to actual model IDs per provider.
// Update these when new models release — everything downstream follows.

export const CLAUDE_MODELS = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-5-20250929",
  haiku: "claude-haiku-4-5-20251001",
};

export const GEMINI_MODELS = {
  opus: "gemini-2.5-pro",
  sonnet: "gemini-2.5-flash",
  haiku: "gemini-2.5-flash",
};

export const OPENAI_MODELS = {
  opus: "gpt-4o",
  sonnet: "gpt-4o-mini",
  haiku: "gpt-4o-mini",
};

export const OLLAMA_MODELS = {
  primary: "qwen3:14b",
  embeddings: "nomic-embed-text",
  // Tier mapping (same interface as cloud providers)
  opus: "qwen3:14b",
  sonnet: "qwen3:14b",
  haiku: "qwen2.5:7b",
};

// ============================================================================
// TIMEOUTS (milliseconds)
// ============================================================================

export const TIMEOUTS = {
  llmDefault: 120000,    // 2 min — standard LLM call
  llmLong: 300000,       // 5 min — complex generation
  llmPoller: 600000,     // 10 min — interactive (Telegram)
  build: 1800000,        // 30 min — build/implementation tasks
};

// ============================================================================
// INTERVALS (milliseconds)
// ============================================================================

export const INTERVALS = {
  dmPoll: 5000,          // Telegram DM polling
  groupPoll: 30000,      // Group message polling
  scheduleCheck: 30000,  // Daemon schedule check
  batchWindow: 1500,     // Message batching window
  taskSweep: 15000,      // Task queue sweep
};

// ============================================================================
// LIMITS
// ============================================================================

export const LIMITS = {
  telegramMaxLength: 4000,
  discordMaxLength: 1900,
  maxConcurrentJobs: 3,
  maxToolRounds: 10,
};

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Validate that required env vars are set. Call at service startup.
 *
 * @param {string[]} required — Env var names to check (keys from the `env` export)
 * @param {string} serviceName — Service name for error messages
 * @throws {Error} if any required vars are missing
 */
export function validateConfig(required, serviceName = "paf") {
  const missing = required.filter((key) => !env[key]);
  if (missing.length > 0) {
    const msg = `[${serviceName}] Missing required env vars: ${missing.join(", ")}`;
    console.error(msg);
    throw new Error(msg);
  }
}
