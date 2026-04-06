/**
 * PAF LLM Provider Adapters — Normalized API interface
 *
 * Each provider implements the same interface:
 *   chat(systemPrompt, messages, opts) -> { text, toolCalls, usage, done }
 *
 * Where:
 *   - systemPrompt: string
 *   - messages: [{ role: "user"|"assistant"|"tool", content, tool_call_id?, tool_calls? }]
 *   - opts: { tools?, model?, maxTokens?, timeout?, temperature? }
 *
 * Returns:
 *   - text: string (final text response)
 *   - toolCalls: [{ id, name, arguments }] (empty if no tool calls)
 *   - usage: { inputTokens, outputTokens, model, durationMs, totalCostUsd }
 *   - done: boolean (true if final, false if tool calls need processing)
 *
 * The provider cascade tries each provider in order until one succeeds.
 * Configure the order via DEFAULT_PROVIDER_ORDER or per-call opts.providers.
 */

import { toClaudeTools, toOpenAITools, toGeminiTools, toOllamaTools } from "./tools.mjs";
import {
  CLAUDE_MODELS,
  GEMINI_MODELS as GEMINI_MODEL_MAP,
  OPENAI_MODELS as OPENAI_MODEL_MAP,
  OLLAMA_MODELS as OLLAMA_MODEL_MAP,
  env,
} from "./config.mjs";
import { execSync } from "child_process";

// ── Credential scrubbing ─────────────────────────────────────
// When routing through third-party providers, scrub secrets from prompts.
const SECRET_PATTERNS = [
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, // JWTs
  /sk[-_][a-zA-Z0-9]{20,}/g,          // API secret keys
  /sbp_[a-f0-9]{30,}/g,               // Supabase tokens
  /AIzaSy[A-Za-z0-9_-]{33}/g,         // Google API keys
  /ghp_[A-Za-z0-9]{30,}/g,            // GitHub PATs
  /xoxb-[0-9]+-[A-Za-z0-9]+/g,       // Slack bot tokens
  /[0-9]{7,}:[A-Za-z0-9_-]{30,}/g,   // Telegram bot tokens
  /rk_live_[A-Za-z0-9]+/g,            // Stripe restricted keys
  /MTQ[A-Za-z0-9]{20,}\.[A-Za-z0-9_-]+/g, // Discord bot tokens
];

export function scrubSecrets(text) {
  let scrubbed = text;
  for (const pattern of SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, "[REDACTED]");
  }
  return scrubbed;
}

// ============================================================================
// PROVIDER: Claude (Anthropic API)
// ============================================================================

function resolveClaudeModel(model) {
  if (!model) return CLAUDE_MODELS.sonnet;
  const lower = model.toLowerCase();
  if (CLAUDE_MODELS[lower]) return CLAUDE_MODELS[lower];
  if (lower.startsWith("claude-")) return model;
  if (lower.includes("opus")) return CLAUDE_MODELS.opus;
  if (lower.includes("haiku")) return CLAUDE_MODELS.haiku;
  return CLAUDE_MODELS.sonnet;
}

async function claudeChat(systemPrompt, messages, opts = {}) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const model = resolveClaudeModel(opts.model);
  const maxTokens = opts.maxTokens || 8192;
  const timeout = opts.timeout || 120000;

  const body = {
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: messages.map((m) => {
      if (m.role === "tool") {
        return {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: m.tool_call_id,
              content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
            },
          ],
        };
      }
      if (m.tool_calls && m.tool_calls.length > 0) {
        const content = [];
        if (m.content) content.push({ type: "text", text: m.content });
        for (const tc of m.tool_calls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: typeof tc.arguments === "string" ? JSON.parse(tc.arguments) : tc.arguments,
          });
        }
        return { role: "assistant", content };
      }
      return { role: m.role, content: m.content };
    }),
  };

  if (opts.tools && opts.tools.length > 0) {
    body.tools = toClaudeTools(opts.tools);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const start = Date.now();
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const data = await res.json();
    const elapsed = Date.now() - start;
    if (data.error) throw new Error(data.error.message);

    let text = "";
    const toolCalls = [];
    for (const block of data.content || []) {
      if (block.type === "text") text += block.text;
      if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, name: block.name, arguments: block.input });
      }
    }

    const usage = data.usage || {};
    return {
      text,
      toolCalls,
      usage: {
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        cacheRead: usage.cache_read_input_tokens || 0,
        cacheCreation: usage.cache_creation_input_tokens || 0,
        model: `anthropic/${model}`,
        durationMs: elapsed,
        totalCostUsd: 0,
        numTurns: 1,
      },
      done: data.stop_reason !== "tool_use",
    };
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// PROVIDER: OpenAI
// ============================================================================

const OPENAI_MODELS = OPENAI_MODEL_MAP;

function resolveOpenAIModel(model) {
  if (!model) return "gpt-4o";
  const lower = model.toLowerCase();
  if (OPENAI_MODELS[lower]) return OPENAI_MODELS[lower];
  if (lower.startsWith("gpt-")) return model;
  return "gpt-4o-mini";
}

async function openaiChat(systemPrompt, messages, opts = {}) {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const model = resolveOpenAIModel(opts.model);
  const timeout = opts.timeout || 120000;

  const apiMessages = [
    { role: "system", content: systemPrompt },
    ...messages.map((m) => {
      if (m.role === "tool") {
        return {
          role: "tool",
          tool_call_id: m.tool_call_id,
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        };
      }
      if (m.tool_calls && m.tool_calls.length > 0) {
        return {
          role: "assistant",
          content: m.content || null,
          tool_calls: m.tool_calls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments:
                typeof tc.arguments === "string"
                  ? tc.arguments
                  : JSON.stringify(tc.arguments),
            },
          })),
        };
      }
      return { role: m.role, content: m.content };
    }),
  ];

  const body = { model, messages: apiMessages, max_tokens: opts.maxTokens || 8192 };
  if (opts.tools && opts.tools.length > 0) {
    body.tools = toOpenAITools(opts.tools);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const start = Date.now();
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const data = await res.json();
    const elapsed = Date.now() - start;
    if (data.error) throw new Error(data.error.message);

    const choice = data.choices?.[0] || {};
    const msg = choice.message || {};

    const toolCalls = (msg.tool_calls || []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments ? JSON.parse(tc.function.arguments) : {},
    }));

    const usage = data.usage || {};
    return {
      text: msg.content || "",
      toolCalls,
      usage: {
        inputTokens: usage.prompt_tokens || 0,
        outputTokens: usage.completion_tokens || 0,
        cacheRead: 0,
        cacheCreation: 0,
        model: `openai/${model}`,
        durationMs: elapsed,
        totalCostUsd: 0,
        numTurns: 1,
      },
      done: choice.finish_reason !== "tool_calls",
    };
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// PROVIDER: Gemini (Google AI)
// ============================================================================

const GEMINI_MODELS = GEMINI_MODEL_MAP;

function resolveGeminiModel(model) {
  if (!model) return "gemini-2.5-flash";
  const lower = model.toLowerCase();
  if (GEMINI_MODELS[lower]) return GEMINI_MODELS[lower];
  if (lower.startsWith("gemini-")) return model;
  if (lower.includes("pro")) return "gemini-2.5-pro";
  return "gemini-2.5-flash";
}

async function geminiChat(systemPrompt, messages, opts = {}) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  const model = resolveGeminiModel(opts.model);
  const timeout = opts.timeout || 120000;

  const contents = messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "function",
        parts: [
          {
            functionResponse: {
              name: m.tool_name || "tool",
              response: {
                result:
                  typeof m.content === "string" ? m.content : JSON.stringify(m.content),
              },
            },
          },
        ],
      };
    }
    if (m.tool_calls && m.tool_calls.length > 0) {
      return {
        role: "model",
        parts: m.tool_calls.map((tc) => ({
          functionCall: {
            name: tc.name,
            args: typeof tc.arguments === "string" ? JSON.parse(tc.arguments) : tc.arguments,
          },
        })),
      };
    }
    return {
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    };
  });

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: { maxOutputTokens: opts.maxTokens || 8192 },
  };

  if (opts.tools && opts.tools.length > 0) {
    body.tools = toGeminiTools(opts.tools);
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const start = Date.now();
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const data = await res.json();
    const elapsed = Date.now() - start;
    if (data.error) throw new Error(data.error.message);

    const candidate = data.candidates?.[0] || {};
    const parts = candidate.content?.parts || [];

    let text = "";
    const toolCalls = [];
    for (const part of parts) {
      if (part.text) text += part.text;
      if (part.functionCall) {
        toolCalls.push({
          id: `gemini_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name: part.functionCall.name,
          arguments: part.functionCall.args || {},
        });
      }
    }

    const meta = data.usageMetadata || {};
    return {
      text,
      toolCalls,
      usage: {
        inputTokens: meta.promptTokenCount || 0,
        outputTokens: meta.candidatesTokenCount || 0,
        cacheRead: 0,
        cacheCreation: 0,
        model: `gemini/${model}`,
        durationMs: elapsed,
        totalCostUsd: 0,
        numTurns: 1,
      },
      done: toolCalls.length === 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// PROVIDER: Ollama (Local)
// ============================================================================

const OLLAMA_URL = env.OLLAMA_URL;
const OLLAMA_MODELS = OLLAMA_MODEL_MAP;

function resolveOllamaModel(model) {
  if (!model) return OLLAMA_MODELS.primary;
  const lower = model.toLowerCase();
  if (OLLAMA_MODELS[lower]) return OLLAMA_MODELS[lower];
  if (lower.includes(":")) return model; // Looks like an Ollama model name
  return OLLAMA_MODELS.primary;
}

async function ollamaChat(systemPrompt, messages, opts = {}) {
  const model = resolveOllamaModel(opts.model);
  const timeout = opts.timeout || 180000;

  const ollamaMessages = [
    { role: "system", content: systemPrompt },
    ...messages.map((m) => {
      if (m.role === "tool") {
        return {
          role: "tool",
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        };
      }
      if (m.tool_calls && m.tool_calls.length > 0) {
        return {
          role: "assistant",
          content: m.content || "",
          tool_calls: m.tool_calls.map((tc) => ({
            function: {
              name: tc.name,
              arguments:
                typeof tc.arguments === "string" ? JSON.parse(tc.arguments) : tc.arguments,
            },
          })),
        };
      }
      return { role: m.role, content: m.content };
    }),
  ];

  const body = {
    model,
    messages: ollamaMessages,
    stream: false,
    options: { num_predict: opts.maxTokens || 4096 },
  };

  if (opts.tools && opts.tools.length > 0) {
    body.tools = toOllamaTools(opts.tools);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const start = Date.now();
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);

    const data = await res.json();
    const elapsed = Date.now() - start;
    const msg = data.message || {};

    // Strip think tags from reasoning models (e.g. qwen)
    let text = (msg.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();

    const toolCalls = (msg.tool_calls || []).map((tc, i) => ({
      id: `ollama_${Date.now()}_${i}`,
      name: tc.function?.name,
      arguments: tc.function?.arguments || {},
    }));

    return {
      text,
      toolCalls,
      usage: {
        inputTokens: data.prompt_eval_count || 0,
        outputTokens: data.eval_count || 0,
        cacheRead: 0,
        cacheCreation: 0,
        model: `ollama/${model}`,
        durationMs: elapsed,
        totalCostUsd: 0,
        numTurns: 1,
      },
      done: toolCalls.length === 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// PROVIDER REGISTRY
// ============================================================================

const PROVIDERS = {
  anthropic: {
    name: "Anthropic (Claude API)",
    chat: claudeChat,
    available: () => !!env.ANTHROPIC_API_KEY,
    resolveModel: resolveClaudeModel,
    scrub: false, // First-party — no scrubbing needed
  },
  gemini: {
    name: "Google Gemini",
    chat: geminiChat,
    available: () => !!env.GEMINI_API_KEY,
    resolveModel: resolveGeminiModel,
    scrub: true, // Third-party — scrub secrets from prompts
  },
  openai: {
    name: "OpenAI",
    chat: openaiChat,
    available: () => !!env.OPENAI_API_KEY,
    resolveModel: resolveOpenAIModel,
    scrub: true,
  },
  ollama: {
    name: "Ollama (Local)",
    chat: ollamaChat,
    available: () => {
      try {
        const res = execSync(
          'curl -sf -o /dev/null -w "%{http_code}" http://localhost:11434/api/tags',
          { timeout: 3000, encoding: "utf-8" }
        ).trim();
        return res === "200";
      } catch {
        return false;
      }
    },
    resolveModel: resolveOllamaModel,
    scrub: false, // Local — no scrubbing needed
  },
};

/**
 * Get list of currently available providers.
 * @returns {string[]}
 */
function getAvailableProviders() {
  return Object.entries(PROVIDERS)
    .filter(([_, p]) => p.available())
    .map(([name]) => name);
}

/**
 * Default provider preference order.
 * Override per-call with opts.providers or opts.provider.
 */
const DEFAULT_PROVIDER_ORDER = ["anthropic", "gemini", "openai", "ollama"];

export {
  PROVIDERS,
  getAvailableProviders,
  DEFAULT_PROVIDER_ORDER,
  claudeChat,
  openaiChat,
  geminiChat,
  ollamaChat,
  scrubSecrets,
};
