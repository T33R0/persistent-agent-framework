/**
 * PAF Semantic Memory
 *
 * Hybrid memory loading: semantic search (via Ollama embeddings) + importance ranking.
 * Graceful fallback to flat importance if Ollama is unavailable.
 *
 * On boot, the agent loads top-N memories by importance (always-relevant context).
 * Per-message, it also loads top-M by cosine similarity to the user's input.
 * Results are deduplicated — the semantic pool excludes the importance pool.
 *
 * Embedding model: nomic-embed-text via Ollama (768 dimensions, matches pgvector column).
 * If Ollama is down, everything still works — you just lose semantic search.
 */

import { supabaseFetch } from "./supabase-client.mjs";
import { loadMemories } from "./agent-boot.mjs";
import { env } from "./config.mjs";

const OLLAMA_URL = env.OLLAMA_URL || "http://localhost:11434";
const EMBEDDING_MODEL = "nomic-embed-text";

// ── Ollama availability check ────────────────────────────────

let _ollamaAvailable = null;
let _ollamaCheckedAt = 0;
const OLLAMA_CHECK_TTL = 30_000; // 30s

async function ensureOllama() {
  const now = Date.now();
  if (_ollamaAvailable !== null && now - _ollamaCheckedAt < OLLAMA_CHECK_TTL) {
    return _ollamaAvailable;
  }
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    _ollamaAvailable = res.ok;
  } catch {
    _ollamaAvailable = false;
  }
  _ollamaCheckedAt = now;
  return _ollamaAvailable;
}

// ── Embedding generation ─────────────────────────────────────

/**
 * Generate an embedding vector for text using Ollama.
 * @param {string} text
 * @returns {Promise<number[]>} 768-dimensional vector
 */
export async function generateEmbedding(text) {
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBEDDING_MODEL, prompt: text }),
  });
  if (!res.ok) throw new Error(`Ollama embedding failed: ${res.status}`);
  const data = await res.json();
  return data.embedding;
}

// ── Hybrid memory loading ────────────────────────────────────

/**
 * Load memories using hybrid semantic + importance search.
 * Falls back to flat importance if Ollama is unavailable.
 *
 * @param {string} agentId
 * @param {string} contextHint — User's message text for semantic matching
 * @param {number} [limit=15]
 * @returns {Promise<Array>}
 */
export async function loadMemoriesHybrid(agentId, contextHint, limit = 15) {
  if (!contextHint) return loadMemories(agentId, limit);

  const ollamaReady = await ensureOllama();
  if (!ollamaReady) {
    console.log("[paf] Ollama unavailable — falling back to flat memory");
    return loadMemories(agentId, limit);
  }

  try {
    const embedding = await generateEmbedding(contextHint);

    // Parallel: semantic search + importance-based
    const [semanticRes, staticMemories] = await Promise.all([
      supabaseFetch("/rest/v1/rpc/hybrid_memory_load", {
        method: "POST",
        body: JSON.stringify({
          p_query_embedding: `[${embedding.join(",")}]`,
          p_importance_limit: 5,
          p_similarity_limit: 10,
        }),
      }),
      loadMemories(agentId, 5),
    ]);

    const semanticMemories = await semanticRes.json();

    // Merge: importance first (always relevant), then semantic (contextually relevant)
    const seen = new Set();
    const merged = [];

    for (const m of Array.isArray(staticMemories) ? staticMemories : []) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        merged.push(m);
      }
    }

    for (const m of Array.isArray(semanticMemories) ? semanticMemories : []) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        merged.push(m);
      }
    }

    console.log(
      `[paf] Hybrid memory: ${staticMemories?.length || 0} static + ${semanticMemories?.length || 0} semantic -> ${merged.length} unique`
    );
    return merged.slice(0, limit);
  } catch (err) {
    console.error("[paf] Semantic memory error, falling back:", err.message);
    return loadMemories(agentId, limit);
  }
}

// ── Save memory with async embedding ─────────────────────────

/**
 * Save a memory and generate its embedding asynchronously.
 * The memory is saved immediately; embedding is fire-and-forget.
 */
export async function saveMemoryWithEmbedding(
  agentId,
  content,
  context,
  category = "general",
  importance = 50
) {
  const res = await supabaseFetch("/rest/v1/agent_memory", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ content, context, category, importance }),
  });
  const [saved] = await res.json();
  if (!saved?.id) return;

  // Generate embedding async (fire-and-forget)
  embedMemory(saved.id, content).catch((err) =>
    console.error(`[paf] Embedding failed for memory ${saved.id}:`, err.message)
  );
}

async function embedMemory(memoryId, content) {
  const ollamaReady = await ensureOllama();
  if (!ollamaReady) return;

  const embedding = await generateEmbedding(content);
  await supabaseFetch(`/rest/v1/agent_memory?id=eq.${memoryId}`, {
    method: "PATCH",
    body: JSON.stringify({
      embedding: `[${embedding.join(",")}]`,
      embedded_at: new Date().toISOString(),
    }),
  });
}
