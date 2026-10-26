// The CLI's side of the performance dashboard: local/mwi.mjs runs its own worker pool, so the server's metrics
// (local/metrics.mjs) never see its jobs. This reporter has the same { onJob, setPool } shape as createMetrics
// and, once a second, POSTs the jobs finished since the last report plus the pool's live state to a running
// `node local/server.mjs` (/local-api/report). No server listening: the report is dropped and the next try
// waits a few seconds, so the CLI runs exactly as without it.
import { performance } from "node:perf_hooks";

const EVERY_MS = 1000, RETRY_MS = 5000, TIMEOUT_MS = 500, MAX_BUFFER = 2000;

export function createMetricsReporter({ url = "http://127.0.0.1:8787", source = `cli ${process.pid}` } = {}) {
  const endpoint = `${url.replace(/\/+$/, "")}/local-api/report`;
  let jobs = [], getPool = () => null, nextTry = 0, sending = null;
  const lastElu = new Map();
  let last = { at: performance.now(), cpu: process.cpuUsage() };

  function onJob({ ok, result, job, runMs, queuedMs, workerId }) {
    jobs.push({
      at: Date.now(), ok, workerId, zone: job?.zone || null, tier: job?.difficultyTier ?? null,
      hours: job?.hours ?? null, players: job?.players?.length ?? null, runMs: runMs || 0, queuedMs: queuedMs || 0,
      simulatedSeconds: Number(result?.simulatedSeconds) || 0, kills: Number(result?.kills) || 0,
      encounters: Number(result?.encountersStarted) || 0,
    });
    if (jobs.length > MAX_BUFFER) jobs.splice(0, jobs.length - MAX_BUFFER);
  }

  function poolState() {
    const now = performance.now(), dt = (now - last.at) / 1000, cpu = process.cpuUsage();
    const processCpuSec = dt > 0 ? ((cpu.user - last.cpu.user) + (cpu.system - last.cpu.system)) / 1e6 / dt : 0;
    last = { at: now, cpu };
    const stats = getPool()?.stats();
    if (!stats) return { threads: 0, busy: 0, queued: 0, workers: [], processCpuSec };
    const workers = [];
    for (const w of stats.workers) {
      let elu;
      try { elu = w.performance.eventLoopUtilization(); } catch { continue; }
      const prev = lastElu.get(w.threadId);
      const d = prev ? w.performance.eventLoopUtilization(elu, prev) : elu;
      lastElu.set(w.threadId, elu);
      workers.push({ id: w.threadId, utilization: +d.utilization.toFixed(4), busyMs: elu.active });
    }
    return { threads: stats.threads, busy: stats.busy, queued: stats.queued, workers, processCpuSec };
  }

  async function send({ final = false } = {}) {
    if (!final && Date.now() < nextTry) return;
    const batch = jobs; jobs = [];
    try {
      const r = await fetch(endpoint, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, pid: process.pid, final, jobs: batch, pool: poolState() }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!r.ok) throw new Error(String(r.status));
    } catch { nextTry = Date.now() + RETRY_MS; }   // no dashboard: these jobs are not kept
  }
  const tick = () => { sending ||= send().finally(() => { sending = null; }); };
  const timer = setInterval(tick, EVERY_MS); timer.unref();

  return {
    onJob,
    setPool(fn) { getPool = fn; },
    // The last report, so the dashboard shows the command's final jobs and drops its workers right away.
    async flush() { clearInterval(timer); await sending; if (Date.now() >= nextTry) await send({ final: true }); },
  };
}
