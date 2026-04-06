/**
 * PAF Portable Tool Definitions + Executors
 *
 * AI-agnostic tool definitions in JSON Schema format.
 * Every major LLM API (Claude, OpenAI, Gemini, Ollama) accepts JSON Schema
 * for function/tool calling. This module defines tools once, executes them
 * locally, and formats them for any provider.
 *
 * Used by: llm-providers.mjs (tool loop) and daemon.mjs (job execution)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { dirname } from "path";
import { SUPABASE_URL, SUPABASE_KEY, headers as supaHeaders } from "./supabase-client.mjs";

// ============================================================================
// TOOL DEFINITIONS — JSON Schema format (universal)
// ============================================================================

const TOOL_DEFINITIONS = [
  {
    name: "supabase_query",
    description:
      "Execute a read-only SQL query against the Supabase database. SELECT and WITH queries only.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "SQL SELECT query to execute" },
      },
      required: ["query"],
    },
  },
  {
    name: "supabase_write",
    description:
      "Execute a write SQL query (INSERT, UPDATE, DELETE) against the Supabase database.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "SQL write query to execute" },
      },
      required: ["query"],
    },
  },
  {
    name: "supabase_rest",
    description: "Make a REST API call to Supabase (PostgREST). For simple CRUD operations.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "REST path, e.g. '/rest/v1/agent_memory?order=importance.desc&limit=5'",
        },
        method: { type: "string", enum: ["GET", "POST", "PATCH", "DELETE"], default: "GET" },
        body: { type: "string", description: "JSON body for POST/PATCH requests" },
      },
      required: ["path"],
    },
  },
  {
    name: "read_file",
    description: "Read the contents of a file from the local filesystem.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the file" },
        offset: { type: "number", description: "Line number to start reading from (1-based)" },
        limit: { type: "number", description: "Maximum number of lines to read" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Write content to a file on the local filesystem. Creates parent directories if needed.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to write to" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "shell_exec",
    description:
      "Execute a shell command and return stdout. Use for system operations, git, npm, etc. Default timeout: 30 seconds.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        cwd: { type: "string", description: "Working directory" },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (default: 30000, max: 120000)",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "http_fetch",
    description: "Make an HTTP request to an external URL. For API calls, webhooks, etc.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          default: "GET",
        },
        headers: { type: "string", description: "JSON object of headers" },
        body: { type: "string", description: "Request body" },
      },
      required: ["url"],
    },
  },
  {
    name: "search_files",
    description: "Search for files matching a glob pattern in the filesystem.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern, e.g. '**/*.mjs' or 'src/**/*.tsx'",
        },
        cwd: { type: "string", description: "Directory to search in" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "grep_content",
    description:
      "Search file contents using a regex pattern. Returns matching lines with file paths.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: { type: "string", description: "File or directory to search in" },
        glob: { type: "string", description: "Filter to specific file types, e.g. '*.mjs'" },
        max_results: { type: "number", description: "Maximum number of results (default: 20)" },
      },
      required: ["pattern"],
    },
  },
];

// ============================================================================
// TOOL EXECUTORS
// ============================================================================

const DEFAULT_CWD = process.cwd();

const TOOL_EXECUTORS = {
  async supabase_query({ query }) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return { error: "Supabase not configured" };
    const normalized = query.trim().toUpperCase();
    if (!normalized.startsWith("SELECT") && !normalized.startsWith("WITH")) {
      return { error: "supabase_query is read-only. Use supabase_write for mutations." };
    }
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/agent_execute_sql`, {
        method: "POST",
        headers: supaHeaders,
        body: JSON.stringify({ sql_query: query }),
      });
      if (res.ok) return await res.json();
      return { error: `Query failed: ${res.status} ${await res.text().catch(() => "")}` };
    } catch (err) {
      return { error: err.message };
    }
  },

  async supabase_write({ query }) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return { error: "Supabase not configured" };
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/agent_execute_sql`, {
        method: "POST",
        headers: supaHeaders,
        body: JSON.stringify({ sql_query: query }),
      });
      if (res.ok) return await res.json();
      return { error: `Write failed: ${res.status} ${await res.text().catch(() => "")}` };
    } catch (err) {
      return { error: err.message };
    }
  },

  async supabase_rest({ path, method = "GET", body }) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return { error: "Supabase not configured" };
    try {
      const opts = { method, headers: supaHeaders };
      if (body && (method === "POST" || method === "PATCH")) opts.body = body;
      const res = await fetch(`${SUPABASE_URL}${path}`, opts);
      return await res.json();
    } catch (err) {
      return { error: err.message };
    }
  },

  async read_file({ path, offset, limit }) {
    try {
      const content = readFileSync(path, "utf-8");
      if (offset || limit) {
        const lines = content.split("\n");
        const start = (offset || 1) - 1;
        const end = limit ? start + limit : lines.length;
        return lines
          .slice(start, end)
          .map((l, i) => `${start + i + 1}\t${l}`)
          .join("\n");
      }
      return content;
    } catch (err) {
      return { error: err.message };
    }
  },

  async write_file({ path, content }) {
    try {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(path, content, "utf-8");
      return { success: true, path };
    } catch (err) {
      return { error: err.message };
    }
  },

  async shell_exec({ command, cwd, timeout }) {
    const execTimeout = Math.min(timeout || 30000, 120000);
    try {
      return execSync(command, {
        cwd: cwd || DEFAULT_CWD,
        encoding: "utf-8",
        timeout: execTimeout,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      return { error: err.message, stderr: err.stderr || "", stdout: err.stdout || "" };
    }
  },

  async http_fetch({ url, method = "GET", headers, body }) {
    try {
      const opts = { method };
      if (headers) opts.headers = JSON.parse(headers);
      if (body) opts.body = body;
      const res = await fetch(url, opts);
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch (err) {
      return { error: err.message };
    }
  },

  async search_files({ pattern, cwd }) {
    try {
      const namePattern = pattern.includes("/") ? pattern.split("/").pop() : pattern;
      const result = execSync(
        `find . -path './.git' -prune -o -path './node_modules' -prune -o -name '${namePattern}' -print | head -50`,
        { cwd: cwd || DEFAULT_CWD, encoding: "utf-8", timeout: 10000 }
      );
      return result.trim().split("\n").filter(Boolean);
    } catch (err) {
      return { error: err.message };
    }
  },

  async grep_content({ pattern, path, glob, max_results = 20 }) {
    const searchPath = path || DEFAULT_CWD;
    const escaped = pattern.replace(/"/g, '\\"');
    const commands = [
      () => {
        let cmd = `set -o pipefail; rg --no-heading -n "${escaped}"`;
        if (glob) cmd += ` -g "${glob}"`;
        cmd += ` --max-count ${max_results} "${searchPath}" | head -${max_results * 3}`;
        return cmd;
      },
      () => {
        let cmd = `grep -rn "${escaped}" "${searchPath}"`;
        if (glob) cmd += ` --include="${glob}"`;
        cmd += ` | head -${max_results * 3}`;
        return cmd;
      },
    ];
    for (const buildCmd of commands) {
      try {
        const result = execSync(buildCmd(), {
          encoding: "utf-8",
          timeout: 15000,
          shell: "/bin/bash",
        });
        return result.trim();
      } catch (err) {
        if (err.status === 1) return "No matches found.";
        if (err.status === 127 || err.message?.includes("not found") || err.message?.includes("ENOENT"))
          continue;
        return { error: err.message };
      }
    }
    return { error: "Neither rg nor grep available" };
  },
};

// ============================================================================
// TOOL FORMAT CONVERTERS — adapt universal definitions to provider formats
// ============================================================================

/** Claude API format: { name, description, input_schema } */
export function toClaudeTools(tools = TOOL_DEFINITIONS) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

/** OpenAI API format: { type: "function", function: { name, description, parameters } } */
export function toOpenAITools(tools = TOOL_DEFINITIONS) {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** Gemini API format: { functionDeclarations: [{ name, description, parameters }] } */
export function toGeminiTools(tools = TOOL_DEFINITIONS) {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    },
  ];
}

/** Ollama format (same as OpenAI) */
export function toOllamaTools(tools = TOOL_DEFINITIONS) {
  return toOpenAITools(tools);
}

// ============================================================================
// TOOL EXECUTION
// ============================================================================

/**
 * Execute a tool by name with given arguments.
 * @param {string} name
 * @param {object} args
 * @returns {Promise<any>}
 */
export async function executeTool(name, args) {
  const executor = TOOL_EXECUTORS[name];
  if (!executor) return { error: `Unknown tool: ${name}` };
  try {
    return await executor(args);
  } catch (err) {
    return { error: `Tool ${name} failed: ${err.message}` };
  }
}

/**
 * Get a subset of tool definitions by name.
 * @param {string[]} names
 * @returns {object[]}
 */
export function getTools(names) {
  if (!names || names.length === 0) return TOOL_DEFINITIONS;
  return TOOL_DEFINITIONS.filter((t) => names.includes(t.name));
}

/**
 * Tool presets — common tool combinations for different job types.
 */
export const TOOL_PRESETS = {
  none: [],
  readonly: ["supabase_query", "supabase_rest", "read_file", "search_files", "grep_content"],
  standard: [
    "supabase_query",
    "supabase_write",
    "supabase_rest",
    "read_file",
    "write_file",
    "search_files",
    "grep_content",
  ],
  full: TOOL_DEFINITIONS.map((t) => t.name),
};

export function getToolPreset(preset) {
  const names = TOOL_PRESETS[preset];
  if (!names) return TOOL_DEFINITIONS;
  if (names.length === 0) return [];
  return getTools(names);
}

export { TOOL_DEFINITIONS, TOOL_EXECUTORS };
