// Splitting one long planet sim into chunks that run on separate threads, and combining their kernel results
// into one. A single 24 h sim on 16 idle threads otherwise runs on one of them.
//
// A chunk that starts cold (full HP and mana, every coffee drunk at once) is not a fair slice of a long run:
// with 2 h chunks, consumables came out ~2.4% high. So every chunk but the first starts with a warm-up that is
// simulated and then subtracted: the kernel is deterministic per seed and a shorter sim is an exact prefix of a
// longer one, so sim(seed, warm + chunk) − sim(seed, warm) is exactly the chunk, played from a warmed-up state.
// The warm-up is 1–2 h, varying per chunk so chunk edges fall at a random point of each drink cycle: mana in a
// party that slowly runs dry takes about that long to settle (with 10–20 min, mean mana read 2.6% high).
//
// Each chunk has its own seed, so a split result is an equally valid sample, not the unsplit one. Dungeons are
// never split: a run is minutes long, and each cut drops the run in progress.

const MIN_CHUNK_HOURS = 3;
const MAX_CHUNKS = 64;
const WARM_HOURS = 1;

// How many chunks each planet sim of a request with `candidates` sims gets, so that together they fill about
// `lanes` threads (callers pass ~3/4 of the cores: every extra chunk adds a warm-up, and on SMT cores the last
// threads add little, so a single 168 h sim ran fastest in 12 chunks on 16 threads). Depends only on the request and the machine, never on the pool's load: same request, same numbers.
export function chunksFor({ hours, candidates, lanes }) {
  const byLanes = Math.floor(lanes / Math.max(1, candidates));
  const byHours = Math.floor((Number(hours) || 0) / MIN_CHUNK_HOURS);
  return Math.max(1, Math.min(MAX_CHUNKS, byLanes, byHours));
}

// Runs `job` as `n` chunks on `pool` and resolves with one combined kernel result.
export async function runSplit(pool, job, n) {
  if (n <= 1) return pool.run(job);
  const hours = Number(job.hours), each = hours / n;
  const anchor = Number(job.epochAnchorMs);
  const chunks = Array.from({ length: n }, (_, i) => {
    const h = i === n - 1 ? hours - each * (n - 1) : each;
    if (i === 0) return pool.run({ ...job, hours: h });   // the first chunk is the unsplit run's own start
    const seed = mix(job.seed, i), warm = WARM_HOURS * (1 + mix(seed, 0x5eed) / 2 ** 31);
    const at = Number.isFinite(anchor) ? { epochAnchorMs: anchor + (i * each - warm) * 3600e3 } : {};
    return Promise.all([pool.run({ ...job, ...at, seed, hours: warm + h }), pool.run({ ...job, ...at, seed, hours: warm })])
      .then(([long, short]) => lin(totals(long), totals(short), -1));
  });
  const parts = await Promise.all(chunks);
  const out = fromTotals(parts.slice(1).reduce((acc, p) => lin(acc, p, 1), totals(parts[0])));
  // Kernel time of the measured hours only (each warm-up's is subtracted with it), so the time estimate's
  // ms-per-hour pace stays right; timer jitter can leave a chunk slightly negative.
  return { ...out, workerMs: Math.max(0, out.workerMs || 0) };
}
const mix = (seed, i) => (Math.imul((Number(seed) >>> 0) ^ Math.imul(i, 0x9e3779b1), 0x85ebca6b) >>> 1) || 1;

// Fields that describe the job or the character rather than count something: kept from the first operand.
const SAME = new Set([
  "zone", "difficultyTier", "isDungeon", "participantCount", "epochAnchorMs", "serverLagMs", "waveTransitionDelayMs",
  "averageRunSeconds", "hrid", "combatLevel", "combatExperience", "combatRareFind", "combatDropRate",
  "combatDropQuantity", "debuffOnLevelGap", "drinkConcentration", "composition", "wave",
]);
// Fractions of the simulated time, per player.
const TIME_SHARE = ["meanManaFraction", "belowPriciestFraction"];
// Lists of { <key>, n, meanSeconds?, castsPerEncounter? }, with means over n.
const GROUPED = { encounterSeconds: "composition", encounterCasts: "composition", dungeonWaveSeconds: "wave", dungeonRunSeconds: "wave" };

// A result with every mean turned into a total and every grouped list into a map, so results add and subtract.
function totals(r) {
  const t = r.simulatedSeconds || 0, out = { ...r };
  out.players = (r.players || []).map(p => {
    const q = { ...p };
    for (const k of TIME_SHARE) if (typeof q[k] === "number") q[k] *= t;
    return q;
  });
  for (const [key, by] of Object.entries(GROUPED)) if (Array.isArray(r[key])) {
    out[key] = Object.fromEntries(r[key].map(e => [e[by], {
      ...e,
      ...(typeof e.meanSeconds === "number" ? { meanSeconds: e.meanSeconds * e.n } : {}),
      ...(e.castsPerEncounter ? { castsPerEncounter: Object.fromEntries(Object.entries(e.castsPerEncounter).map(([a, v]) => [a, v * e.n])) } : {}),
    }]));
  }
  return out;
}

function fromTotals(r) {
  const t = r.simulatedSeconds || 0, out = { ...r };
  out.players = r.players.map(p => {
    const q = { ...p };
    for (const k of TIME_SHARE) if (typeof q[k] === "number") q[k] = t > 0 ? q[k] / t : 0;
    return q;
  });
  for (const key of Object.keys(GROUPED)) if (r[key] && !Array.isArray(r[key])) {
    out[key] = Object.values(r[key]).filter(e => e.n > 0).map(e => ({
      ...e,
      ...(typeof e.meanSeconds === "number" ? { meanSeconds: e.meanSeconds / e.n } : {}),
      ...(e.castsPerEncounter ? { castsPerEncounter: Object.fromEntries(Object.entries(e.castsPerEncounter).map(([a, v]) => [a, v / e.n])) } : {}),
    }));
  }
  return out;
}

// a + sign·b over counters: numbers add, maps add per key, lists per position; everything else keeps a's value.
function lin(a, b, sign, key = "") {
  if (SAME.has(key)) return a ?? b;
  if (typeof a === "number" || typeof b === "number") return (Number(a) || 0) + sign * (Number(b) || 0);
  if (Array.isArray(a) || Array.isArray(b)) {
    const len = Math.max(a?.length || 0, b?.length || 0);
    return Array.from({ length: len }, (_, i) => lin(a?.[i], b?.[i], sign));
  }
  if ((a && typeof a === "object") || (b && typeof b === "object")) {
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    return Object.fromEntries([...keys].map(k => [k, lin(a?.[k], b?.[k], sign, k)]));
  }
  return a ?? b;
}
