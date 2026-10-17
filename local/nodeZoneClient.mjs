// The Node twin of zone-web/zoneClient.js: the same zone API modules (server/*.mjs), but the kernel runs in
// worker_threads instead of Web Workers, the market cache is a file instead of localStorage, and nothing is
// capped by what the browser reports as hardwareConcurrency.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { createZoneApi } from "../server/zoneApi.mjs";
import { loadMarketFrom } from "../server/marketCore.mjs";
import { pace, seedPace } from "../server/zoneSim.mjs";
import { initSync, describe } from "../kernel-zone/wasm/pkg/mwi_zone_wasm.js";
import { createNodePool } from "./nodePool.mjs";
import { chunksFor, runSplit } from "./splitJob.mjs";

const ROOT = new URL("../", import.meta.url);
const CACHE_DIR = new URL("./.cache/", import.meta.url);
const MARKET_FILE = new URL("market.json", CACHE_DIR);
const PACE_FACTOR = 1.21;   // same head-start on the time estimate as the browser client

const readJson = rel => JSON.parse(readFileSync(new URL(rel, ROOT), "utf8"));
const clone = v => JSON.parse(JSON.stringify(v));
const httpError = e => new Error(`${e?.status || 500} ${JSON.stringify({ error: String(e?.message || e) })}`);
const wrap = async fn => { try { return clone(await fn()); } catch (e) { throw httpError(e); } };

function marketLoader() {
  let cached = { at: 0, value: null };
  const store = {
    read: () => { try { return readFileSync(MARKET_FILE, "utf8"); } catch { return null; } },
    write: text => { try { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(MARKET_FILE, text); } catch { /* not kept */ } },
  };
  return async ({ force = false } = {}) => {
    if (!force && Date.now() - cached.at < 60e3) return cached.value;
    const value = await loadMarketFrom({ ...store, ...(force ? { maxAgeMs: 0 } : {}), log: m => console.warn(`[zone] ${m}`) });
    cached = { at: Date.now(), value };
    return value;
  };
}

export function createNodeZoneClient({ workers = availableParallelism(), maxWorkers = availableParallelism(), metrics = null, split = true } = {}) {
  const initData = readJson("init_client_data.json");
  let icons = null;
  try { icons = readJson("zone-web/icons.json"); } catch { /* icons are optional */ }
  initSync({ module: readFileSync(new URL("kernel-zone/wasm/pkg/mwi_zone_wasm_bg.wasm", ROOT)) });
  seedPace(pace() * PACE_FACTOR);

  let pool = null;
  const getPool = () => (pool ||= createNodePool(workers, { onJob: metrics?.onJob }));
  metrics?.setPool(() => pool);
  const describeJob = job => JSON.parse(describe(JSON.stringify(job)));
  const getMarket = marketLoader();
  const apiWith = pool => createZoneApi({
    initData,
    icons: icons ? () => Object.fromEntries(Object.entries(icons).map(([k, v]) => [k, { ...v, ids: new Set(v.ids) }])) : null,
    getPool: async () => pool(),
    getDescribe: async () => describeJob,
    getMarket,
  });
  const api = apiWith(getPool);

  // A Run request with fewer sims than threads leaves most of them idle, so each of its planet sims runs as
  // several chunks (local/splitJob.mjs). The searches (upgrades, triggers, skills) fill every thread already
  // and are not split. The chunk count depends on the request and the core count only, so the same request
  // gives the same numbers whatever else is running.
  const lanes = Math.max(1, Math.round(availableParallelism() * 3 / 4));
  const dungeons = new Set(api.zones().filter(z => z.isDungeon).map(z => z.hrid));
  const runApi = body => {
    const candidates = Array.isArray(body?.candidates) ? body.candidates.length : 1;
    if (!split || candidates >= lanes) return api;
    return apiWith(() => ({
      get size() { return getPool().size; },
      run: job => runSplit(getPool(), job, dungeons.has(job.zone) ? 1 : chunksFor({ hours: job.hours, candidates, lanes })),
    }));
  };

  // One streamed request: forwards head/row/step events and resolves with the "done" summary, exactly as the
  // browser client's *Stream methods do.
  const stream = (method, body, { onHead, onRow, onStep } = {}) => {
    let closed = false, headSent = false;
    const done = (async () => {
      try {
        const r = await (method === "run" ? runApi(body) : api)[method](body, {
          onHead: h => { headSent = true; onHead?.(clone({ kind: "head", ...h })); },
          onRow: row => { if (!closed) onRow?.(clone({ kind: "row", ...row })); },
          onStep: s => { if (!closed) onStep?.(clone({ ...s, kind: "step" })); },
          isClosed: () => closed,
        });
        if (method === "run") return { kind: "done", ms: r.ms, candidates: r.candidates.length, evaluated: r.evaluated, stopped: r.stopped };
        if (method === "upgrades") return { kind: "done", ms: r.ms, candidates: r.candidates, evaluated: r.evaluated, stopped: r.stopped };
        if (method === "triggers") return clone({ kind: "done", ms: r.ms, stopped: r.stopped, steps: r.steps, changes: r.changes, combined: r.combined, players: r.players });
        return clone({ kind: "done", ms: r.ms, stopped: r.stopped, ranked: r.ranked, curves: r.curves });
      } catch (e) {
        if (!headSent) throw httpError(e);
        return { kind: "done", ms: null, stopped: true };
      }
    })();
    return { abort: () => { closed = true; }, done };
  };

  return {
    get maxWorkers() { return maxWorkers; },
    get workers() { return workers; },
    setWorkers(n) {
      workers = Math.max(1, Math.min(maxWorkers, Math.floor(Number(n)) || 1));
      pool?.resize(workers);
      return workers;
    },
    zones: () => wrap(() => api.zones()),
    zoneImport: p => wrap(() => api.importCharacters(typeof p === "string" ? { text: p } : p)),
    zoneCatalog: () => wrap(() => api.catalog()),
    zoneDerive: b => wrap(() => api.derive(b)),
    zoneRun: b => wrap(() => runApi(b).run(b)),
    zoneLimits: () => wrap(() => api.limits()),
    zoneMarket: () => wrap(() => api.market()),
    zoneMarketRefresh: () => wrap(() => api.market({ refresh: true })),
    zoneUpgrades: b => wrap(() => api.upgrades(b)),
    zoneUpgradeCount: b => wrap(() => api.upgradeCount(b)),
    zoneTriggers: b => wrap(() => api.triggers(b)),
    zoneSkills: b => wrap(() => api.skills(b)),
    stream,
    close() { pool?.close(); pool = null; },
  };
}
