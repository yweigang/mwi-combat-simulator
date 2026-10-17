// Local mode: serves the site from this checkout and runs every simulation in Node worker threads.
//
//   node local/server.mjs [--port 8787] [--workers N] [--host 127.0.0.1] [--no-open] [--no-split]
//
// The page is the same index.html; zoneApi.js notices /local-api/ping answers and sends its zone calls here
// instead of starting Web Workers. Streamed requests (run, upgrades, triggers, skills) come back as NDJSON,
// one event per line; closing the request (the page's Stop button) stops the search. --no-split runs every sim
// on one thread, as the browser does (local/splitJob.mjs: a Run with few sims otherwise splits them into chunks).
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { availableParallelism } from "node:os";
import { exec } from "node:child_process";
import { createNodeZoneClient } from "./nodeZoneClient.mjs";
import { createMetrics } from "./metrics.mjs";
import { buildWorkload, runWorkload } from "./bench.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const PORT = Number(opt("port", process.env.PORT || 8787));
// 127.0.0.1 keeps the simulator off the network. Docker Desktop's host.docker.internal reaches it there; on
// Linux Docker, run with --host 0.0.0.0 so the Prometheus container can scrape /metrics.
const HOST = opt("host", "127.0.0.1");
const CORES = availableParallelism();
const WORKERS = Math.max(1, Math.min(CORES, Number(opt("workers", CORES)) || CORES));
const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

const metrics = createMetrics({ cores: CORES });
const zone = createNodeZoneClient({ workers: WORKERS, maxWorkers: CORES, metrics, split: !args.includes("--no-split") });

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".css": "text/css; charset=utf-8", ".wasm": "application/wasm",
  ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp", ".jpg": "image/jpeg", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".md": "text/plain; charset=utf-8",
};

// Plain request/response methods: POST /local-api/<name> with the argument as the JSON body.
const CALLS = {
  zones: () => zone.zones(), zoneCatalog: () => zone.zoneCatalog(), zoneLimits: () => zone.zoneLimits(),
  zoneMarket: () => zone.zoneMarket(), zoneMarketRefresh: () => zone.zoneMarketRefresh(),
  zoneImport: b => zone.zoneImport(b), zoneDerive: b => zone.zoneDerive(b), zoneRun: b => zone.zoneRun(b),
  zoneUpgrades: b => zone.zoneUpgrades(b), zoneUpgradeCount: b => zone.zoneUpgradeCount(b),
  zoneTriggers: b => zone.zoneTriggers(b), zoneSkills: b => zone.zoneSkills(b),
  setWorkers: b => ({ workers: zone.setWorkers(b?.workers ?? WORKERS) }),
  // The dashboard's "Run load test": local/bench.mjs's fixed workload, through the same pool the page uses.
  bench: async b => {
    const body = await buildWorkload(zone, { hours: Number(b?.hours) || 24, repeat: Math.min(20, Math.max(1, Number(b?.repeat) || 1)) });
    return { workers: zone.workers, ...(await runWorkload(zone, body)) };
  },
};
const STREAMS = new Set(["run", "upgrades", "triggers", "skills"]);
const live = new Map();   // stream id -> { abort } for the page's Stop button

const readBody = req => new Promise((ok, fail) => {
  const chunks = [];
  req.on("data", c => chunks.push(c)).on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8");
    try { ok(text ? JSON.parse(text) : undefined); } catch (e) { fail(e); }
  }).on("error", fail);
});
const sendJson = (res, status, value) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
};

async function handleApi(req, res, path) {
  if (path === "ping") return sendJson(res, 200, { ok: true, cores: CORES, workers: zone.workers, maxWorkers: zone.maxWorkers });
  if (path === "metrics") return sendJson(res, 200, metrics.snapshot({ since: Number(new URL(req.url, "http://localhost").searchParams.get("since")) || 0 }));
  if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" });
  const body = await readBody(req);
  if (path === "abort") { live.get(String(body?.id))?.abort(); return sendJson(res, 200, { value: true }); }

  if (path.startsWith("stream/")) {
    const method = path.slice(7);
    if (!STREAMS.has(method)) return sendJson(res, 404, { error: `no stream ${method}` });
    res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
    const line = v => { if (!res.writableEnded) res.write(JSON.stringify(v) + "\n"); };
    const id = String(new URL(req.url, "http://localhost").searchParams.get("id") || "");
    const s = zone.stream(method, body, { onHead: line, onRow: line, onStep: line });
    if (id) live.set(id, s);
    res.on("close", () => { if (!res.writableFinished) s.abort(); });
    try { line(await s.done); } catch (e) { line({ kind: "error", error: String(e?.message || e) }); }
    finally { if (id) live.delete(id); }
    return res.end();
  }

  const call = CALLS[path];
  if (!call) return sendJson(res, 404, { error: `no method ${path}` });
  try { sendJson(res, 200, { value: await call(body) }); }
  catch (e) { sendJson(res, 200, { error: String(e?.message || e) }); }
}

function serveStatic(req, res, path) {
  let file = resolve(ROOT, normalize(decodeURIComponent(path)).replace(/^[/\\]+/, ""));
  if (file !== ROOT && !file.startsWith(ROOT + sep)) { res.writeHead(403); return res.end(); }
  try {
    if (statSync(file).isDirectory()) file = resolve(file, "index.html");
    const st = statSync(file);
    res.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] || "application/octet-stream", "content-length": st.size, "cache-control": "no-cache" });
    createReadStream(file).pipe(res);
  } catch { res.writeHead(404); res.end("not found"); }
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/metrics") {   // Prometheus scrape target (local/grafana/)
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" });
      return res.end(metrics.prometheus());
    }
    if (url.pathname.startsWith("/local-api/")) return await handleApi(req, res, url.pathname.slice(11));
    serveStatic(req, res, url.pathname);
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: String(e?.message || e) }); else res.end();
  }
}).on("error", e => {
  if (e.code !== "EADDRINUSE") throw e;
  console.error(`Port ${PORT} is already in use: is the simulator already running? Stop it, or start this one with --port <other>.`);
  process.exit(1);
}).listen(PORT, HOST, () => {
  const link = `http://localhost:${PORT}/`;
  console.log(`MWI combat simulator (local mode): ${link}`);
  console.log(`Performance dashboard: ${link}local/dashboard.html · Prometheus metrics: ${link}metrics`);
  console.log(`${WORKERS} of ${CORES} cores simulating in Node worker threads. Ctrl+C to stop.`);
  if (!args.includes("--no-open")) {
    const cmd = process.platform === "win32" ? `start "" "${link}"` : process.platform === "darwin" ? `open "${link}"` : `xdg-open "${link}"`;
    exec(cmd, () => {});
  }
});
