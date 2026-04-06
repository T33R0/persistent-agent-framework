/**
 * PAF Marker Engine — Resilient marker extraction for agent responses.
 *
 * Markers are inline tags in LLM output that trigger side effects:
 * saving memories, updating state, logging wins/mistakes, etc.
 * They are invisible to the user — stripped before display.
 *
 * Format: [TAG]{json}[/TAG] or [TAG]{json} (closing tag optional)
 *
 * JSON objects are self-delimiting via brace matching, making closing tags
 * optional. This prevents silent data loss when the LLM omits a closing
 * tag on long JSON payloads — a hard lesson from production.
 *
 * Usage:
 *   import { MarkerEngine } from './marker-engine.mjs';
 *   const engine = new MarkerEngine();
 *   engine.register('MEMORY', async (data) => saveMemory(data));
 *   const { cleanText, results } = await engine.process(llmResponse);
 */

// ── Core extraction (brace-matching, not regex) ──────────────

/**
 * Extract JSON payloads from a marker tag using brace matching.
 * Handles both [TAG]{json}[/TAG] and [TAG]{json} (no closing tag).
 *
 * @param {string} text — Response text to search
 * @param {string} tag  — Marker name (e.g. "MEMORY")
 * @returns {Array<{json: string, parsed: object|null, start: number, end: number}>}
 */
export function extractMarkerJson(text, tag) {
  const results = [];
  const openTag = `[${tag}]`;
  const closeTag = `[/${tag}]`;
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const tagIdx = text.indexOf(openTag, searchFrom);
    if (tagIdx === -1) break;

    const afterTag = tagIdx + openTag.length;

    // Skip whitespace to find opening brace
    let braceIdx = afterTag;
    while (braceIdx < text.length && /[\s]/.test(text[braceIdx])) braceIdx++;

    if (braceIdx >= text.length || text[braceIdx] !== "{") {
      searchFrom = afterTag;
      continue;
    }

    // Match balanced braces (handles nested objects, strings with braces, escapes)
    let depth = 0;
    let inStr = false;
    let esc = false;
    let jsonEnd = -1;

    for (let i = braceIdx; i < text.length; i++) {
      const c = text[i];
      if (esc) { esc = false; continue; }
      if (c === "\\" && inStr) { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      if (c === "}") {
        depth--;
        if (depth === 0) { jsonEnd = i; break; }
      }
    }

    if (jsonEnd === -1) {
      // Malformed JSON — skip this marker
      searchFrom = afterTag;
      continue;
    }

    const jsonStr = text.slice(braceIdx, jsonEnd + 1);

    // Try to parse the JSON
    let parsed = null;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      // JSON extraction succeeded but parsing failed — still strip it
    }

    // Consume optional closing tag after JSON
    let matchEnd = jsonEnd + 1;
    let lookAhead = matchEnd;
    while (lookAhead < text.length && /[\s]/.test(text[lookAhead])) lookAhead++;
    if (text.startsWith(closeTag, lookAhead)) {
      matchEnd = lookAhead + closeTag.length;
    }

    results.push({ json: jsonStr, parsed, start: tagIdx, end: matchEnd });
    searchFrom = matchEnd;
  }

  return results;
}

/**
 * Extract plain-text content from a marker tag.
 * Uses traditional regex (requires closing tag).
 *
 * @param {string} text
 * @param {string} tag
 * @returns {Array<{content: string, start: number, end: number}>}
 */
export function extractMarkerText(text, tag) {
  const results = [];
  const regex = new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[\\/${tag}\\]`, "g");
  let match;
  while ((match = regex.exec(text)) !== null) {
    results.push({
      content: match[1].trim(),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return results;
}

/**
 * Strip a specific marker tag from text (both JSON and plain-text formats).
 *
 * @param {string} text
 * @param {string} tag
 * @returns {string}
 */
export function stripMarker(text, tag) {
  // Strip JSON-payload markers via brace matching
  const payloads = extractMarkerJson(text, tag);
  for (let i = payloads.length - 1; i >= 0; i--) {
    text = text.slice(0, payloads[i].start) + text.slice(payloads[i].end);
  }
  // Safety net: also strip any closed-format markers the brace matcher might miss
  text = text.replace(new RegExp(`\\[${tag}\\][\\s\\S]*?\\[\\/${tag}\\]`, "gs"), "");
  return text;
}

// ── Marker Engine (registry + processing) ────────────────────

/**
 * MarkerEngine — Register handlers for marker types, then process LLM responses.
 *
 * @example
 *   const engine = new MarkerEngine();
 *
 *   // Register JSON-payload markers
 *   engine.register('MEMORY', async (data) => {
 *     await saveMemory(data.content, data.context, data.category);
 *   });
 *
 *   engine.register('STATE', async (data) => {
 *     await upsertState(data.key, data.value);
 *   });
 *
 *   // Register plain-text markers
 *   engine.register('SEARCH', async (data) => {
 *     return await searchWeb(data.content); // return value becomes tool result
 *   }, { format: 'text' });
 *
 *   // Process a response
 *   const { cleanText, results } = await engine.process(llmResponse);
 *   // cleanText has all markers stripped
 *   // results is array of { tag, data, result, error }
 */
export class MarkerEngine {
  constructor() {
    /** @type {Map<string, {handler: Function, format: 'json'|'text'}>} */
    this.handlers = new Map();
  }

  /**
   * Register a marker handler.
   *
   * @param {string} tag — Marker name (e.g. "MEMORY", "STATE")
   * @param {Function} handler — async (data) => result. For JSON markers, data is the
   *   parsed object. For text markers, data is { content: string }.
   * @param {object} [opts]
   * @param {'json'|'text'} [opts.format='json'] — Whether this marker carries JSON or plain text
   */
  register(tag, handler, opts = {}) {
    this.handlers.set(tag, {
      handler,
      format: opts.format || "json",
    });
  }

  /**
   * Get all registered marker tag names.
   * @returns {string[]}
   */
  get tags() {
    return [...this.handlers.keys()];
  }

  /**
   * Process an LLM response: extract all markers, execute handlers, strip markers.
   *
   * @param {string} text — Raw LLM response
   * @returns {Promise<{cleanText: string, results: Array<{tag: string, data: any, result: any, error: string|null}>}>}
   */
  async process(text) {
    const results = [];

    for (const [tag, { handler, format }] of this.handlers) {
      const extractions =
        format === "json"
          ? extractMarkerJson(text, tag).map((e) => e.parsed).filter(Boolean)
          : extractMarkerText(text, tag).map((e) => ({ content: e.content }));

      for (const data of extractions) {
        try {
          const result = await handler(data);
          results.push({ tag, data, result, error: null });
        } catch (err) {
          console.error(`[paf] Marker handler ${tag} failed:`, err.message);
          results.push({ tag, data, result: null, error: err.message });
        }
      }
    }

    // Strip all registered markers from the response
    let cleanText = text;
    for (const tag of this.handlers.keys()) {
      cleanText = stripMarker(cleanText, tag);
    }
    cleanText = cleanText.trim();

    return { cleanText, results };
  }

  /**
   * Strip all registered markers from text without executing handlers.
   * Useful for cleaning stored conversation history.
   *
   * @param {string} text
   * @returns {string}
   */
  strip(text) {
    for (const tag of this.handlers.keys()) {
      text = stripMarker(text, tag);
    }
    return text.trim();
  }
}

// ── Default marker set (starter kit) ─────────────────────────

/**
 * Create a MarkerEngine pre-loaded with the standard PAF marker handlers.
 * These cover the core persistence loop: memory, state, ledger, journal.
 *
 * You still need to provide the actual persistence functions — this just
 * wires the marker names to your callbacks.
 *
 * @param {object} callbacks — Your persistence layer
 * @param {Function} callbacks.saveMemory    — (data: {content, context?, category?, importance?}) => void
 * @param {Function} callbacks.upsertState   — (data: {key, value}) => void
 * @param {Function} callbacks.logWin        — (data: {what, why?}) => void
 * @param {Function} callbacks.logMistake    — (data: {what, why?, should_have?, pattern?}) => void
 * @param {Function} callbacks.saveJournal   — (data: {entry, mood?, time_of_day?}) => void
 * @param {Function} [callbacks.addTask]     — (data: {title, description?, priority?}) => void
 * @param {Function} [callbacks.editTask]    — (data: {id, updates}) => void
 * @param {Function} [callbacks.removeTask]  — (data: {id}) => void
 * @param {Function} [callbacks.onStyleFeedback] — (data: {directive, category?}) => void
 * @returns {MarkerEngine}
 */
export function createDefaultEngine(callbacks) {
  const engine = new MarkerEngine();

  engine.register("MEMORY", async (data) => {
    await callbacks.saveMemory(data);
  });

  engine.register("STATE", async (data) => {
    await callbacks.upsertState(data);
  });

  engine.register("WIN", async (data) => {
    await callbacks.logWin(data);
  });

  engine.register("MISTAKE", async (data) => {
    await callbacks.logMistake(data);
  });

  engine.register("JOURNAL", async (data) => {
    await callbacks.saveJournal(data);
  });

  if (callbacks.addTask) {
    engine.register("TASK_ADD", async (data) => {
      await callbacks.addTask(data);
    });
  }

  if (callbacks.editTask) {
    engine.register("TASK_EDIT", async (data) => {
      await callbacks.editTask(data);
    });
  }

  if (callbacks.removeTask) {
    engine.register("TASK_REMOVE", async (data) => {
      await callbacks.removeTask(data);
    });
  }

  if (callbacks.onStyleFeedback) {
    engine.register("STYLE_FEEDBACK", async (data) => {
      await callbacks.onStyleFeedback(data);
    });
  }

  return engine;
}
