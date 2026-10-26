// Performance metrics for local mode. Every finished kernel job is recorded (local/nodePool.mjs's onJob, or a
// CLI's report through ingest(), see local/metricsReporter.mjs), and once a second a sample of throughput,
// worker utilization, CPU and memory goes into a ten-minute ring buffer.
// Two views of the same numbers:
//   snapshot()    JSON for the built-in dashboard (local/dashboard.html)
//   prometheus()  the Prometheus text format, for Grafana (local/grafana/)
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";

const HISTORY = 600;                       // one-second samples kept for the dashboard
const RECENT = 40;                         // finished jobs listed on the dashboard
const RUN_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];       // seconds per job
const PER_HOUR_BUCKETS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2500];                      // kernel ms per simulated hour
const REMOTE_TTL = 3000;                   // a CLI that has not reported for this long has stopped

const histogram = buckets => ({ buckets, counts: new Array(buckets.length).fill(0), sum: 0, count: 0 });
const observe = (h, v) => { h.sum += v; h.count++; for (let i = 0; i < h.buckets.length; i++) if (v <= h.buckets[i]) h.counts[i]++; };
const quantile = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null;
const cpuTimes = () => cpus().reduce((a, c) => { const t = c.times; a.idle += t.idle; a.total += t.user + t.nice + t.sys + t.idle + t.irq; return a; }, { idle: 0, total: 0 });

export function createMetrics({ cores = cpus().length } = {}) {
  const startedAt = Date.now();
  const totals = { jobs: 0, failed: 0, simulatedSeconds: 0, kills: 0, encounters: 0, kernelMs: 0, queuedMs: 0 };
  const runHist = histogram(RUN_BUCKETS), perHourHist = histogram(PER_HOUR_BUCKETS);
  const recent = [], history = [], window = [];   // window: jobs finished in the last 10 s, for quantiles
  const workerBusyMs = new Map();                 // threadId -> cumulative active ms (retired threads keep theirs)
  const lastElu = new Map();
  const remotes = new Map();                      // CLI source -> { seen, pool } from its latest report
  let getPool = () => null;
  let last = { at: performance.now(), totals: { ...totals }, cpu: process.cpuUsage(), sys: cpuTimes() };
  let current = null;

  function record({ at = Date.now(), source = "page", ok, workerId, zone, tier, hours, players, runMs, queuedMs, simulatedSeconds, kills, encounters }) {
    const simSec = Number(simulatedSeconds) || 0;
    runMs = Number(runMs) || 0; queuedMs = Number(queuedMs) || 0;
    totals.jobs++; if (!ok) totals.failed++;
    totals.simulatedSeconds += simSec;
    totals.kills += Number(kills) || 0;
    totals.encounters += Number(encounters) || 0;
    totals.kernelMs += runMs;
    totals.queuedMs += queuedMs;
    observe(runHist, runMs / 1000);
    const perHour = simSec > 0 ? runMs / (simSec / 3600) : null;
    if (perHour != null) observe(perHourHist, perHour);
    const entry = {
      at, source, ok: !!ok, workerId, zone: zone || null, tier: tier ?? null, hours: hours ?? null, players: players ?? null,
      runMs: Math.round(runMs), queuedMs: Math.round(queuedMs),
      msPerSimHour: perHour == null ? null : +perHour.toFixed(2), kills: Number(kills) || 0,
    };
    recent.unshift(entry); if (recent.length > RECENT) recent.pop();
    window.push(entry);
  }

  function onJob({ ok, result, job, runMs, queuedMs, workerId }) {
    record({
      ok, workerId, zone: job?.zone, tier: job?.difficultyTier, hours: job?.hours, players: job?.players?.length,
      runMs, queuedMs, simulatedSeconds: result?.simulatedSeconds, kills: result?.kills, encounters: result?.encountersStarted,
    });
  }

  // A CLI process's report (local/metricsReporter.mjs): its finished jobs count like the server's own, and its
  // pool's live state is added to the samples until it stops reporting (or says it is done).
  function ingest({ source, jobs, pool, final } = {}) {
    const src = String(source || "cli").slice(0, 40);
    const list = Array.isArray(jobs) ? jobs.slice(0, 5000) : [];
    for (const j of list) record({ ...j, source: src, workerId: `${src}/${j?.workerId ?? "?"}`, at: Number(j?.at) || Date.now() });
    if (list.length) { window.sort((a, b) => a.at - b.at); recent.sort((a, b) => b.at - a.at); }
    if (final) remotes.delete(src);
    else if (pool) {
      remotes.set(src, { seen: Date.now(), pool });
      for (const w of pool.workers || []) workerBusyMs.set(`${src}/${w.id}`, Number(w.busyMs) || 0);
    }
    return { ok: true };
  }
  const liveRemotes = () => {
    const cutoff = Date.now() - REMOTE_TTL;
    for (const [k, r] of remotes) if (r.seen < cutoff) remotes.delete(k);
    return [...remotes];
  };

  function workerSample() {
    const pool = getPool();
    if (!pool) return { util: [], stats: null };
    const stats = pool.stats(), util = [];
    for (const w of stats.workers) {
      let elu;
      try { elu = w.performance.eventLoopUtilization(); } catch { continue; }
      const prev = lastElu.get(w.threadId);
      const d = prev ? w.performance.eventLoopUtilization(elu, prev) : elu;
      lastElu.set(w.threadId, elu);
      workerBusyMs.set(w.threadId, elu.active);
      util.push({ id: w.threadId, utilization: +d.utilization.toFixed(4) });
    }
    return { util, stats };
  }

  function sample() {
    const now = performance.now(), dt = (now - last.at) / 1000;
    if (dt <= 0) return;
    const cpu = process.cpuUsage(), sys = cpuTimes();
    const d = k => (totals[k] - last.totals[k]) / dt;
    const { util, stats } = workerSample();
    let busy = stats?.busy ?? 0, queued = stats?.queued ?? 0, threads = stats?.threads ?? 0, remoteCpuSec = 0;
    for (const [src, { pool }] of liveRemotes()) {
      busy += Number(pool.busy) || 0; queued += Number(pool.queued) || 0; threads += Number(pool.threads) || 0;
      remoteCpuSec += Number(pool.processCpuSec) || 0;
      for (const w of pool.workers || []) util.push({ id: `${src}/${w.id}`, source: src, utilization: Number(w.utilization) || 0 });
    }
    const cutoff = Date.now() - 10e3;
    while (window.length && window[0].at < cutoff) window.shift();
    const perHour = window.map(j => j.msPerSimHour).filter(v => v != null).sort((a, b) => a - b);
    const mem = process.memoryUsage();
    const sysTotal = sys.total - last.sys.total;
    current = {
      t: Date.now(),
      jobsPerSec: d("jobs"),
      simHoursPerSec: d("simulatedSeconds") / 3600,
      killsPerSec: d("kills"),
      encountersPerSec: d("encounters"),
      effectiveCores: d("kernelMs") / 1000,        // kernel-busy seconds per wall second: parallel speedup in use
      utilization: util.length ? util.reduce((a, w) => a + w.utilization, 0) / util.length : 0,
      busy, queued, threads,
      processCpu: (((cpu.user - last.cpu.user) + (cpu.system - last.cpu.system)) / 1e6 / dt + remoteCpuSec) / cores,
      systemCpu: sysTotal > 0 ? 1 - (sys.idle - last.sys.idle) / sysTotal : 0,
      rssMB: mem.rss / 1048576, heapMB: mem.heapUsed / 1048576,
      p50MsPerSimHour: quantile(perHour, 0.5), p95MsPerSimHour: quantile(perHour, 0.95),
      workers: util,
    };
    history.push({ ...current, workers: undefined });
    if (history.length > HISTORY) history.shift();
    last = { at: now, totals: { ...totals }, cpu, sys };
  }
  const timer = setInterval(sample, 1000); timer.unref();

  function snapshot({ since = 0 } = {}) {
    return {
      startedAt, uptimeSec: (Date.now() - startedAt) / 1000, cores,
      totals: { ...totals, simulatedHours: totals.simulatedSeconds / 3600 },
      current, history: since ? history.filter(h => h.t > since) : history, recent, reporters: liveRemotes().map(([k]) => k),
    };
  }

  function prometheus() {
    const out = [];
    const metric = (name, type, help, rows) => {
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      for (const [labels, v] of rows) out.push(`${name}${labels} ${Number.isFinite(v) ? v : 0}`);
    };
    const hist = (name, help, h) => {
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} histogram`);
      h.buckets.forEach((b, i) => out.push(`${name}_bucket{le="${b}"} ${h.counts[i]}`));
      out.push(`${name}_bucket{le="+Inf"} ${h.count}`, `${name}_sum ${h.sum}`, `${name}_count ${h.count}`);
    };
    metric("mwi_sim_jobs_total", "counter", "Kernel simulations finished.", [[`{status="ok"}`, totals.jobs - totals.failed], [`{status="error"}`, totals.failed]]);
    metric("mwi_sim_simulated_seconds_total", "counter", "In-game seconds simulated.", [["", totals.simulatedSeconds]]);
    metric("mwi_sim_kills_total", "counter", "Monsters killed in simulation.", [["", totals.kills]]);
    metric("mwi_sim_encounters_total", "counter", "Encounters started in simulation.", [["", totals.encounters]]);
    metric("mwi_sim_kernel_seconds_total", "counter", "Wall time workers spent inside the kernel.", [["", totals.kernelMs / 1000]]);
    metric("mwi_sim_queue_wait_seconds_total", "counter", "Time jobs waited for a free worker.", [["", totals.queuedMs / 1000]]);
    hist("mwi_sim_run_seconds", "Kernel wall time per simulation.", runHist);
    hist("mwi_sim_kernel_ms_per_simulated_hour", "Kernel milliseconds per simulated in-game hour.", perHourHist);
    metric("mwi_worker_busy_seconds_total", "counter", "Active time of each worker thread (rate = utilization).",
      [...workerBusyMs].map(([id, ms]) => [`{worker="${id}"}`, ms / 1000]));
    const s = getPool()?.stats(), cli = liveRemotes().map(([, r]) => r.pool);
    const plus = k => cli.reduce((a, p) => a + (Number(p[k]) || 0), 0);
    metric("mwi_pool_workers", "gauge", "Configured worker threads (server plus reporting CLIs).", [["", (s?.size ?? 0) + plus("threads")]]);
    metric("mwi_pool_busy_workers", "gauge", "Workers running a job right now.", [["", (s?.busy ?? 0) + plus("busy")]]);
    metric("mwi_pool_queued_jobs", "gauge", "Jobs waiting for a worker.", [["", (s?.queued ?? 0) + plus("queued")]]);
    metric("mwi_cli_reporters", "gauge", "CLI processes reporting to this server.", [["", cli.length]]);
    metric("mwi_machine_cores", "gauge", "Logical cores on this machine.", [["", cores]]);
    metric("mwi_system_cpu_ratio", "gauge", "Whole-machine CPU use, 0..1 (last second).", [["", current?.systemCpu ?? 0]]);
    const cpu = process.cpuUsage(), mem = process.memoryUsage();
    metric("process_cpu_seconds_total", "counter", "CPU time of the simulator process, all threads.", [["", (cpu.user + cpu.system) / 1e6]]);
    metric("process_resident_memory_bytes", "gauge", "Resident memory of the simulator process.", [["", mem.rss]]);
    metric("nodejs_heap_used_bytes", "gauge", "V8 heap in use (main thread).", [["", mem.heapUsed]]);
    return out.join("\n") + "\n";
  }

  return { onJob, ingest, snapshot, prometheus, setPool(fn) { getPool = fn; } };
}
