/**
 * PAF Supabase Client
 *
 * Single source of truth for Supabase URL, key, headers, and fetch wrapper.
 * All runtime modules import from here instead of defining their own.
 *
 * Environment variables:
 *   SUPABASE_URL            — Your Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Service role key (server-side only, never expose to client)
 */

export const SUPABASE_URL = process.env.SUPABASE_URL;
export const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn("[paf] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — DB operations will fail");
}

export const headers = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
};

/**
 * Fetch wrapper with error handling for Supabase REST API.
 * @param {string} path — REST path (e.g. "/rest/v1/agent_memory?order=importance.desc")
 * @param {object} opts — Additional fetch options (method, body, headers, etc.)
 * @returns {Promise<Response>}
 */
export async function supabaseFetch(path, opts = {}) {
  const url = `${SUPABASE_URL}${path}`;
  const mergedHeaders = opts.headers ? { ...headers, ...opts.headers } : headers;
  const { headers: _, ...restOpts } = opts;
  const res = await fetch(url, { headers: mergedHeaders, ...restOpts });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Supabase ${opts.method || "GET"} ${path} failed: ${res.status} ${body.substring(0, 200)}`
    );
  }
  return res;
}
