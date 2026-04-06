/**
 * PAF Daemon Runner — Generic sweep-based daemon loop
 *
 * The daemon is a long-running process that periodically sweeps for work:
 * - Task queue items (conversation replies, proactive messages, cross-mode requests)
 * - Scheduled jobs (health checks, QA sweeps, embedding generation)
 * - Heartbeat tasks (one-off background jobs)
 *
 * Architecture:
 *   1. Each "sweep" function checks for work, claims it atomically, processes it
 *   2. The main loop runs all sweeps on their individual intervals
 *   3. Circuit breaker: 3 consecutive failures for a sweep -> disable + alert
 *   4. Health check: writes heartbeat to agent_state for liveness monitoring
 *
 * Usage:
 *   import { DaemonRunner } from './daemon.mjs';
 *   const daemon = new DaemonRunner('my-agent');
 *   daemon.addSweep('tasks', sweepTaskQueue, { intervalMs: 10000 });
 *   daemon.addSweep('embeddings', sweepEmbeddings, { intervalMs: 60000 });
 *   daemon.start();
 */

import { supabaseFetch } from "./supabase-client.mjs";

export class DaemonRunner {
  /**
   * @param {string} name — Daemon identifier (for logging and heartbeat)
   * @param {object} [opts]
   * @param {number} [opts.healthIntervalMs=30000] — Health check interval
   * @param {number} [opts.maxConsecutiveFailures=3] — Circuit breaker threshold
   */
  constructor(name, opts = {}) {
    this.name = name;
    this.healthIntervalMs = opts.healthIntervalMs || 30000;
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures || 3;
    this.sweeps = new Map();
    this.running = false;
    this.timers = [];
  }

  /**
   * Register a sweep function.
   *
   * @param {string} name — Sweep identifier
   * @param {Function} fn — async () => void. Runs on each interval tick.
   * @param {object} [opts]
   * @param {number} [opts.intervalMs=15000] — How often to run
   * @param {boolean} [opts.runImmediately=true] — Run once on start before first interval
   */
  addSweep(name, fn, opts = {}) {
    this.sweeps.set(name, {
      fn,
      intervalMs: opts.intervalMs || 15000,
      runImmediately: opts.runImmediately !== false,
      consecutiveFailures: 0,
      disabled: false,
      lastRun: null,
      lastError: null,
    });
  }

  /**
   * Start the daemon. Runs until stop() is called.
   */
  start() {
    if (this.running) return;
    this.running = true;
    console.log(`[daemon:${this.name}] Starting with ${this.sweeps.size} sweeps`);

    // Health check timer
    this.timers.push(
      setInterval(() => this._writeHealthCheck(), this.healthIntervalMs)
    );
    this._writeHealthCheck();

    // Start each sweep on its interval
    for (const [name, sweep] of this.sweeps) {
      if (sweep.runImmediately) {
        this._runSweep(name, sweep);
      }
      const timer = setInterval(() => this._runSweep(name, sweep), sweep.intervalMs);
      this.timers.push(timer);
    }

    // Graceful shutdown
    process.on("SIGINT", () => this.stop());
    process.on("SIGTERM", () => this.stop());
  }

  /**
   * Stop the daemon.
   */
  stop() {
    if (!this.running) return;
    this.running = false;
    console.log(`[daemon:${this.name}] Stopping`);
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  /**
   * Run a single sweep with circuit breaker protection.
   */
  async _runSweep(name, sweep) {
    if (!this.running || sweep.disabled) return;

    try {
      await sweep.fn();
      sweep.consecutiveFailures = 0;
      sweep.lastRun = new Date().toISOString();
      sweep.lastError = null;
    } catch (err) {
      sweep.consecutiveFailures++;
      sweep.lastError = err.message;
      console.error(
        `[daemon:${this.name}] Sweep "${name}" failed (${sweep.consecutiveFailures}/${this.maxConsecutiveFailures}):`,
        err.message
      );

      // Circuit breaker
      if (sweep.consecutiveFailures >= this.maxConsecutiveFailures) {
        sweep.disabled = true;
        console.error(
          `[daemon:${this.name}] CIRCUIT BREAKER: Sweep "${name}" disabled after ${this.maxConsecutiveFailures} consecutive failures`
        );
        // Write alert to task queue
        this._writeAlert(name, sweep.lastError).catch(() => {});
      }
    }
  }

  /**
   * Write a health check to agent_state.
   */
  async _writeHealthCheck() {
    try {
      const sweepStatus = {};
      for (const [name, sweep] of this.sweeps) {
        sweepStatus[name] = {
          disabled: sweep.disabled,
          lastRun: sweep.lastRun,
          failures: sweep.consecutiveFailures,
          lastError: sweep.lastError,
        };
      }

      await supabaseFetch("/rest/v1/agent_state?on_conflict=key", {
        method: "POST",
        headers: { Prefer: "return=representation,resolution=merge-duplicates" },
        body: JSON.stringify({
          key: `daemon_health_${this.name}`,
          value: {
            running: this.running,
            sweeps: sweepStatus,
            lastCheck: new Date().toISOString(),
            pid: process.pid,
          },
          updated_at: new Date().toISOString(),
        }),
      });
    } catch (err) {
      console.error(`[daemon:${this.name}] Health check write failed:`, err.message);
    }
  }

  /**
   * Write a circuit breaker alert to the task queue.
   */
  async _writeAlert(sweepName, error) {
    try {
      await supabaseFetch("/rest/v1/agent_task_queue", {
        method: "POST",
        body: JSON.stringify({
          task: "daemon_circuit_breaker",
          payload: {
            daemon: this.name,
            sweep: sweepName,
            error,
            timestamp: new Date().toISOString(),
          },
          priority: 1,
          status: "pending",
        }),
      });
    } catch {
      // Best effort — if we can't write the alert, we've already logged it
    }
  }
}

// ── Sweep helpers ────────────────────────────────────────────

/**
 * Create a sweep that processes tasks from agent_task_queue.
 *
 * @param {string} taskType — Task type to claim (e.g. 'web_conversation', 'proactive')
 * @param {Function} handler — async (task) => void. Process a single task.
 * @param {object} [opts]
 * @param {number} [opts.batchSize=5] — Max tasks to claim per sweep
 * @returns {Function} Sweep function for DaemonRunner.addSweep
 */
export function createTaskSweep(taskType, handler, opts = {}) {
  const batchSize = opts.batchSize || 5;

  return async function sweepTasks() {
    // Claim pending tasks atomically
    const res = await supabaseFetch(
      `/rest/v1/agent_task_queue?task=eq.${taskType}&status=eq.pending&order=created_at.asc&limit=${batchSize}`,
    );
    const tasks = await res.json();
    if (!tasks.length) return;

    for (const task of tasks) {
      // Claim
      const claimRes = await supabaseFetch(
        `/rest/v1/agent_task_queue?id=eq.${task.id}&status=eq.pending`,
        {
          method: "PATCH",
          body: JSON.stringify({ status: "claimed", claimed_at: new Date().toISOString() }),
        }
      );
      const claimed = await claimRes.json();
      if (!claimed.length) continue; // Someone else claimed it

      try {
        await handler(task);
        await supabaseFetch(`/rest/v1/agent_task_queue?id=eq.${task.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            status: "completed",
            completed_at: new Date().toISOString(),
          }),
        });
      } catch (err) {
        console.error(`[sweep:${taskType}] Task ${task.id} failed:`, err.message);
        await supabaseFetch(`/rest/v1/agent_task_queue?id=eq.${task.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            status: "failed",
            error: err.message,
            completed_at: new Date().toISOString(),
          }),
        });
      }
    }
  };
}

/**
 * Create a sweep that generates embeddings for unembedded records.
 *
 * @param {Function} generateEmbeddingFn — async (text) => number[]
 * @param {object} [opts]
 * @param {number} [opts.batchSize=10]
 * @returns {Function}
 */
export function createEmbeddingSweep(generateEmbeddingFn, opts = {}) {
  const batchSize = opts.batchSize || 10;

  return async function sweepEmbeddings() {
    // Get unembedded memories
    const res = await supabaseFetch(
      `/rest/v1/agent_memory?embedding=is.null&order=importance.desc&limit=${batchSize}`
    );
    const records = await res.json();
    if (!records.length) return;

    let embedded = 0;
    for (const record of records) {
      try {
        const embedding = await generateEmbeddingFn(record.content);
        await supabaseFetch(`/rest/v1/agent_memory?id=eq.${record.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            embedding: `[${embedding.join(",")}]`,
            embedded_at: new Date().toISOString(),
          }),
        });
        embedded++;
      } catch (err) {
        console.error(`[sweep:embeddings] Failed for ${record.id}:`, err.message);
      }
    }

    if (embedded > 0) console.log(`[sweep:embeddings] Embedded ${embedded} records`);
  };
}
