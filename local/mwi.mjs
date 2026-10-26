// Command-line front end to the same zone API the page uses, so a script (or an assistant in a terminal) can
// import a party, run zones, compare loadouts and search abilities without the UI. Everything runs in Node
// worker threads, exactly as local mode does.
//
//   node local/mwi.mjs help
//
// The imported party and the settings live in local/.state/ (party.json, settings.json): plain JSON, so a
// loadout can also be edited by hand between runs. Names are matched loosely everywhere: "porcupine" for
// /actions/combat/porcupine, "water strike" or "water_strike" for /abilities/water_strike, a player by any
// unambiguous part of their name.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { createNodeZoneClient } from "./nodeZoneClient.mjs";

const STATE_DIR = new URL("./.state/", import.meta.url);
const PARTY_FILE = new URL("party.json", STATE_DIR);
const SETTINGS_FILE = new URL("settings.json", STATE_DIR);
const SLOT_INT = [1, 20, 50, 90];   // Intelligence levels that open the normal ability slots
const PRICE_DEFAULTS = { loot: "bid", consumables: "ask", keys: "craft", keyMaterials: "ask", capes: "zero", catalyst: "none", mode: "standard", artisanTea: true };

const HELP = `MWI combat simulator, command line (local/mwi.mjs)

State: local/.state/party.json (the imported party, editable) and local/.state/settings.json.
Every command takes --json for machine-readable output and --workers N (default: every core).

  import <file|-> [--add]        Import an MWI Party Export / sim export (file, or - for stdin).
                                 --add appends (a taken name becomes "Name (2)").
  party [name] [--full]          The party: levels, gear, abilities (with levels and triggers), food, drinks,
                                 and the abilities the export says are owned.
  seat <name,...|all>            Which players run by default (the "seated" party). Default: all.
  zones [filter]                 Zones with their hrid, party size and highest tier.
  catalog <abilities|food|drinks|items|triggers> [filter]
                                 Game data: ability mana/cooldown/style, food and drink effects, items by slot.
  config [key=value ...]         Show or set settings: pricing.<field>, buffs (JSON), wave=<ms>, seed=<n>,
                                 task.<player>=<monster>. "config reset" clears them.

  run --zone Z [--tier T] [--hours 24] [--seeds 3] [--players A,B] [--detail] [mods...]
                                 Simulate the seated party (or --players). Mean and standard error over seeds.
                                 --detail adds per-player casts, damage by source, mana, consumables, loot.
                                 Several zones: --zone a,b,c  Several tiers: --tier 0,1,2

  compare --zone Z [--tier T] [--hours 300] [--seeds 4] --variant "label: mods" [--variant ...]
                                 Every variant on the same seeds; paired difference vs the first (the base,
                                 which is the party as it stands unless the first variant has mods).
                                 Mods, ';'-separated, each "Player.what=value":
                                   A.abilities=water_strike@100,frost_surge@98,mana_spring   (replace all; @level,
                                                default: owned level, else 1; the special goes in automatically)
                                   A.ability+=fireball@90      A.ability-=frost_surge
                                   A.food=dragon_fruit_yogurt,spaceberry_cake    A.drinks=...
                                   A.equip=royal_water_robe_top+10     A.unequip=back
                                   A.level.magic=170     A.trigger.frost_surge=<json array>
                                   A.loadout=@file.json  (whole loadout from a file)
                                 run takes the same mods via --mod "..." (repeatable).

  best-abilities --player A --zone Z [--tier T] [--metric xp|profit|kills] [--hours 300] [--seeds 2]
                 [--slots N] [--levels a@100,b@90] [--only a,b,c] [--exclude a,b] [--no-fit] [--max 300]
                                 Which ability set fills A's slots best (the page's Best abilities search).
                                 Levels: --levels, else the export's owned abilities, else the loadout's.
                                 --no-fit also tries damage abilities of other combat styles.
                                 Up to --max sets every set runs; past that, a swap-by-swap local search.
                                 --apply puts the winner in the party file. New abilities get default triggers.

  upgrades|triggers|skills --zone Z [--tier T] [--player A] [--metric xp|profit] [--hours H] [--seeds S]
                 [--body extra.json] [--out result.json]
                                 The page's optimizers. Defaults are the page's; --body merges any extra
                                 request fields. The full result is written to --out (default local/.state/).
                                 triggers --apply writes the tuned trigger values into the party file.
                                 --minutes N caps a search's time.
  raw <method> [body.json|-]     Call a zone API method directly (zoneRun, zoneDerive, ...) and print JSON.
`;

// ——— small helpers ———
const args = process.argv.slice(2);
const cmd = args[0];
const flags = {}, pos = [], multi = { variant: [], mod: [] };
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith("--")) {
    const k = a.slice(2), next = args[i + 1];
    const v = next === undefined || next.startsWith("--") ? true : (i++, next);
    if (k in multi) multi[k].push(v); else flags[k] = v;
  } else pos.push(a);
}
const asJson = !!flags.json;
const num = (v, fb) => { const n = Number(v); return v === undefined || v === true || !Number.isFinite(n) ? fb : n; };
const readJson = (url, fb) => { try { return JSON.parse(readFileSync(url, "utf8")); } catch { return fb; } };
const writeState = (url, v) => { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(url, JSON.stringify(v, null, 2)); };
const norm = s => String(s || "").toLowerCase().replace(/^\/[a-z_]+\/(combat\/)?/, "").replace(/[\s-]+/g, "_");
const short = h => String(h || "").replace(/^\/[a-z_]+\/(combat\/)?/, "");
const clone = v => JSON.parse(JSON.stringify(v));
const fmt = (x, d = 0) => x == null || !Number.isFinite(x) ? "-" : x.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const coins = x => { if (x == null || !Number.isFinite(x)) return "-"; const a = Math.abs(x);
  return (x < 0 ? "-" : "") + (a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}k` : a.toFixed(0)); };
const pm = (m, se, d = 0, f = fmt) => se == null ? f(m, d) : `${f(m, d)} ±${f(se, d)}`;
const out = v => console.log(JSON.stringify(v, null, 2));
const die = msg => { console.error(`error: ${msg}`); process.exit(1); };
const progress = msg => { if (process.stderr.isTTY) process.stderr.write(`\r${msg}\x1b[K`); };
const progressEnd = () => { if (process.stderr.isTTY) process.stderr.write("\r\x1b[K"); };

function pickOne(list, query, key, what) {
  const q = norm(query);
  const exact = list.filter(x => norm(key(x)) === q || norm(x.name) === q);
  if (exact.length === 1) return exact[0];
  const part = list.filter(x => norm(key(x)).includes(q) || norm(x.name).includes(q));
  if (part.length === 1) return part[0];
  if (!part.length) die(`no ${what} matches "${query}"`);
  die(`"${query}" matches several ${what}s: ${part.slice(0, 12).map(x => x.name || short(key(x))).join(", ")}`);
}

// ——— the client and the game data ———
let zoneClient = null, cache = {};
const client = () => (zoneClient ||= createNodeZoneClient({ workers: num(flags.workers, availableParallelism()), split: false }));
const zones = async () => (cache.zones ||= await client().zones());
const catalog = async () => (cache.catalog ||= await client().zoneCatalog());
const party = () => readJson(PARTY_FILE, null) || die("no party yet: run `import <export file>` first");
const settings = () => readJson(SETTINGS_FILE, {});
const nameOf = p => p?.record?.name || "?";

const findZone = async q => pickOne(await zones(), q, z => z.hrid, "zone");
const findAbility = async q => pickOne((await catalog()).abilities.map(a => ({ ...a, hrid: a.abilityHrid })), q, a => a.abilityHrid, "ability");
const allItems = async () => (cache.items ||= (await catalog()).slots.flatMap(s => s.items.map(i => ({ ...i, slot: s.hrid, conflicts: s.conflicts || [] }))));
const findItem = async q => pickOne(await allItems(), q, i => i.itemHrid, "item");
const findConsumable = async (kind, q) => pickOne((await catalog())[kind], q, i => i.itemHrid, kind === "food" ? "food" : "drink");
const findPlayer = (players, q) => pickOne(players.map(p => ({ p, name: nameOf(p) })), q, x => x.name, "player").p;

function seatedPlayers(all, override) {
  if (override) return String(override).split(",").map(n => findPlayer(all, n.trim()));
  const seat = settings().seat;
  return seat?.length ? seat.map(n => all.find(p => nameOf(p) === n)).filter(Boolean) : all;
}

async function abilityRank(hrid) {
  const d = (await catalog()).abilities.find(a => a.abilityHrid === hrid);
  return !d ? 1 : d.isSpecial ? 0 : Number(d.cooldownSeconds) === 0 ? 2 : 1;
}
async function sortAbilities(list) {
  const ranked = await Promise.all(list.map(async (a, k) => [a, k, await abilityRank(a.hrid)]));
  return ranked.sort((x, y) => x[2] - y[2] || x[1] - y[1]).map(x => x[0]);
}
/** The levels this player has in every ability: the export's owned list, else the loadout's. */
function ownedLevels(p) {
  const m = new Map();
  for (const a of p?.record?.owned?.abilities || p?.owned?.abilities || []) if (a?.abilityHrid) m.set(a.abilityHrid, Number(a.level) || 0);
  for (const a of p?.loadout?.abilities || []) if (a?.hrid && !m.get(a.hrid)) m.set(a.hrid, Number(a.level) || 0);
  return m;
}
function mainStyle(p) {
  const L = p?.record?.levels || {};
  if ((p?.loadout?.equipment || []).some(e => /bulwark/i.test(String(e?.itemHrid || "")))) return "melee";
  return ["melee", "ranged", "magic"].reduce((a, k) => (L[k] || 0) > (L[a] || 0) ? k : a, "magic");
}
async function setAbilities(p, list) {
  const keep = new Set(list.map(a => a.hrid));
  const trig = { ...(p.loadout.abilityTriggers || {}) };
  for (const h of Object.keys(trig)) if (h.startsWith("/abilities/") && !keep.has(h)) delete trig[h];
  p.loadout.abilities = await sortAbilities(list);
  p.loadout.abilityTriggers = trig;
}

// ——— mods: "Player.what=value; ..." applied to a copy of the party ———
async function applyMods(players, spec) {
  const parts = String(spec || "").split(";").map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    const m = part.match(/^(.+?)\.([a-z_.+-]+?)(\+=|-=|=)(.*)$/i);
    if (!m) die(`can't read mod "${part}" (expected Player.what=value)`);
    const [, who, what, op, raw] = m, value = raw.trim();
    const p = findPlayer(players, who), lo = p.loadout;
    const owned = ownedLevels(p);
    const abil = async tok => { const [n, l] = tok.split("@"); const a = await findAbility(n.trim());
      return { hrid: a.abilityHrid, level: Math.max(1, num(l, owned.get(a.abilityHrid) || 1)) }; };
    const key = what.toLowerCase();
    if (key === "abilities") await setAbilities(p, await Promise.all(value.split(",").filter(Boolean).map(abil)));
    else if (key === "ability" && op === "+=") { const a = await abil(value); await setAbilities(p, [...lo.abilities.filter(x => x.hrid !== a.hrid), a]); }
    else if (key === "ability" && op === "-=") { const a = await findAbility(value); await setAbilities(p, lo.abilities.filter(x => x.hrid !== a.abilityHrid)); }
    else if (key === "food" || key === "drinks") {
      const items = await Promise.all(value.split(",").filter(Boolean).map(async n => ({ itemHrid: (await findConsumable(key, n.trim())).itemHrid })));
      lo[key] = { ...(lo[key] || {}), "/action_types/combat": items };
    } else if (key === "equip") {
      const [n, l] = value.split("+"), it = await findItem(n.trim());
      const slotOf = async h => (await allItems()).find(i => i.itemHrid === h)?.slot;
      const clash = new Set([it.slot, ...it.conflicts]);
      const kept = [];
      for (const e of lo.equipment || []) if (!clash.has(await slotOf(e.itemHrid))) kept.push(e);
      lo.equipment = [...kept, { itemHrid: it.itemHrid, enhancementLevel: num(l, 0) }];
    } else if (key === "unequip") {
      const q = norm(value), slotOf = async h => (await allItems()).find(i => i.itemHrid === h)?.slot;
      const kept = [];
      for (const e of lo.equipment || []) { const s = await slotOf(e.itemHrid); if (!(norm(s) === q || norm(e.itemHrid).includes(q))) kept.push(e); }
      lo.equipment = kept;
    } else if (key.startsWith("level.")) p.record.levels[key.slice(6)] = num(value, p.record.levels[key.slice(6)]);
    else if (key.startsWith("trigger.")) { const a = await findAbility(key.slice(8)); lo.abilityTriggers = { ...lo.abilityTriggers, [a.abilityHrid]: JSON.parse(value) }; }
    else if (key === "loadout") p.loadout = JSON.parse(readFileSync(value.replace(/^@/, ""), "utf8"));
    else die(`unknown mod "${what}" in "${part}"`);
  }
  return players;
}

// ——— running ———
function baseBody() {
  const s = settings(), body = { pricing: { ...PRICE_DEFAULTS, ...(s.pricing || {}) } };
  if (s.buffs) body.accountBuffs = s.buffs;
  if (s.wave != null) body.waveTransitionDelayMs = s.wave;
  return body;
}
const withTasks = players => { const t = settings().task || {};
  return players.map(p => ({ ...p, record: { ...p.record, taskMonsterHrid: t[nameOf(p)] || null } })); };

/** The page's per-run summary (compSummary): party XP / h, profit / day, kills / h, deaths / h, keys / h. */
function summary(c) {
  const ps = c.players || [], sum = f => ps.reduce((a, p) => a + (Number(f(p)) || 0), 0);
  const same = ps.length > 0 && ps.every(p => p.profitPerHour === ps[0].profitPerHour);
  const income = same ? ps[0].incomePerHour || 0 : sum(p => p.incomePerHour);
  const expenses = same ? ps[0].expensesPerHour || 0 : sum(p => p.expensesPerHour);
  let keys = 0;
  for (const p of ps) for (const it of p.loot?.income?.items || []) if (/_key(_fragment)?$/.test(it.itemHrid || "")) keys += Number(it.perHour) || 0;
  return { xp: sum(p => p.experiencePerHour?.total), profit: (income - expenses) * 24, kills: Number(c.killsPerHour) || 0,
    deaths: sum(p => p.deathsPerHour), rate: c.isDungeon ? Number(c.dungeonsCompletedPerHour) || 0 : Number(c.encountersPerHour) || 0, keys };
}
const METRICS = ["xp", "profit", "kills", "deaths", "rate", "keys"];
function stats(values) {
  const v = values.filter(x => x != null && Number.isFinite(x));
  if (!v.length) return { mean: null, se: null };
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return { mean: m, se: v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1) / v.length) : null };
}

/** Runs `players` on one zone/tier for every seed, in parallel; returns the raw candidates per seed. */
async function runSeeds(players, { zone, tier, hours, seeds, seed0 }) {
  const body = { ...baseBody(), players: withTasks(players), hours, candidates: [{ zone, difficultyTier: tier, hours }] };
  return Promise.all(Array.from({ length: seeds }, async (_, k) => {
    const r = await client().zoneRun({ ...body, seed: seed0 + k });
    const c = r?.candidates?.[0];
    if (!c || c.ok === false) throw new Error(c?.error || "the run was refused");
    return c;
  }));
}
function aggregate(cands) {
  const sums = cands.map(summary), agg = {};
  for (const k of METRICS) agg[k] = stats(sums.map(s => s[k]));
  return { agg, sums };
}
/** Per-player detail averaged over seeds. */
function playerDetail(cands) {
  const names = cands[0].players.map(p => p.hrid);
  const avgMap = (getter) => { const acc = {};
    for (const c of cands) for (const [k, v] of Object.entries(getter(c) || {})) acc[k] = (acc[k] || 0) + (Number(v) || 0) / cands.length;
    return acc; };
  const avg = getter => cands.reduce((a, c) => a + (Number(getter(c)) || 0), 0) / cands.length;
  return names.map((n, i) => {
    const P = c => c.players[i];
    return {
      name: n, combatLevel: P(cands[0]).combatLevel,
      xpPerHour: avgMap(c => P(c).experiencePerHour), deathsPerHour: avg(c => P(c).deathsPerHour),
      dps: avg(c => P(c).damagePerHour) / 3600, damagePerHour: avg(c => P(c).damagePerHour),
      damageBySourcePerHour: avgMap(c => P(c).damageBySourcePerHour),
      damageTakenPerHour: avg(c => P(c).damageTakenPerHour), damageTakenBySourcePerHour: avgMap(c => P(c).damageTakenBySourcePerHour),
      castsPerHour: avgMap(c => P(c).abilityCastsPerHour), healingPerHour: avg(c => P(c).healingPerHour),
      healingBySourcePerHour: avgMap(c => P(c).healingBySourcePerHour),
      manaRestoredPerHour: avg(c => P(c).manaRestoredPerHour), meanManaFraction: avg(c => P(c).meanManaFraction),
      manaExhaustionFraction: avg(c => P(c).manaExhaustionFraction), manaDeniedCastsPerHour: avg(c => P(c).manaDeniedCastsPerHour),
      manaDeniedShare: avg(c => P(c).manaDeniedShare), hitRate: avg(c => P(c).hitRate),
      consumablesPerHour: avgMap(c => P(c).consumablesUsedPerHour),
      incomePerHour: avg(c => P(c).incomePerHour), expensesPerHour: avg(c => P(c).expensesPerHour), profitPerHour: avg(c => P(c).profitPerHour),
      lootPerHour: avgMap(c => Object.fromEntries((P(c).loot?.income?.items || []).map(it => [it.itemHrid, it.coinsPerHour]))),
    };
  });
}
const topMap = (m, n = 8, f = v => fmt(v)) => Object.entries(m || {}).filter(([, v]) => v).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${short(k)} ${f(v)}`).join(", ") || "-";

function printDetail(d) {
  for (const p of d) {
    const xp = p.xpPerHour || {};
    console.log(`  ${p.name} (combat ${fmt(p.combatLevel, 1)}): XP/h ${fmt(xp.total)} [${Object.entries(xp).filter(([k, v]) => k !== "total" && v > 0).map(([k, v]) => `${k} ${fmt(v)}`).join(", ")}]  deaths/h ${fmt(p.deathsPerHour, 2)}`);
    console.log(`    DPS ${fmt(p.dps, 1)} · hit rate ${fmt(100 * p.hitRate, 1)}% · damage/h by source: ${topMap(p.damageBySourcePerHour)}`);
    console.log(`    casts/h: ${topMap(p.castsPerHour, 10, v => fmt(v, 1))}`);
    console.log(`    mana: mean ${fmt(100 * p.meanManaFraction, 1)}% full, dry ${fmt(100 * p.manaExhaustionFraction, 1)}% of time, casts lost to mana ${fmt(p.manaDeniedCastsPerHour, 1)}/h (${fmt(100 * p.manaDeniedShare, 1)}%) · restored/h ${fmt(p.manaRestoredPerHour)}`);
    console.log(`    taken/h ${fmt(p.damageTakenPerHour)} (${topMap(p.damageTakenBySourcePerHour, 5)}) · healing/h ${fmt(p.healingPerHour)} (${topMap(p.healingBySourcePerHour, 5)})`);
    console.log(`    consumables/h: ${topMap(p.consumablesPerHour, 8, v => fmt(v, 1))}`);
    console.log(`    coins/h: income ${coins(p.incomePerHour)}, expenses ${coins(p.expensesPerHour)}, profit ${coins(p.profitPerHour)} · top loot: ${topMap(p.lootPerHour, 5, coins)}`);
  }
}

const runOpts = async (defHours, defSeeds) => {
  if (!flags.zone || flags.zone === true) die("--zone is required (see `zones`)");
  const zs = await Promise.all(String(flags.zone).split(",").map(z => findZone(z.trim())));
  const tiers = String(flags.tier ?? 0).split(",").map(Number);
  const s = settings();
  return { zs, tiers, hours: num(flags.hours, defHours), seeds: Math.max(1, num(flags.seeds, defSeeds)), seed0: num(flags.seed, s.seed ?? 1) };
};
function checkTier(z, t) { if (t > z.maxDifficulty) die(`${z.name} goes up to tier ${z.maxDifficulty}`); }

// ——— commands ———
const commands = {
  async help() { console.log(HELP); },

  async import() {
    const src = pos[0]; if (!src) die("import <file|->");
    const text = src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
    const r = await client().zoneImport({ text });
    let players = r.players || [];
    if (flags.add) {
      const prev = readJson(PARTY_FILE, []), taken = new Set(prev.map(nameOf));
      for (const p of players) { let n = nameOf(p), base = n, k = 2; while (taken.has(n)) n = `${base} (${k++})`; p.record.name = n; taken.add(n); }
      players = [...prev, ...players];
    }
    writeState(PARTY_FILE, players);
    if (asJson) return out({ players: players.map(nameOf), errors: r.errors, warnings: r.warnings, format: r.format });
    console.log(`imported ${r.players.length} player(s) (${r.format}); party is now: ${players.map(nameOf).join(", ")}`);
    for (const e of r.errors || []) console.log(`  error: ${typeof e === "string" ? e : JSON.stringify(e)}`);
    for (const w of r.warnings || []) console.log(`  warning: ${typeof w === "string" ? w : JSON.stringify(w)}`);
  },

  async party() {
    const all = party(), list = pos[0] ? [findPlayer(all, pos[0])] : all;
    if (asJson) return out(list);
    const items = await allItems(), slotName = h => (items.find(i => i.itemHrid === h)?.slot || "").replace("/item_locations/", "");
    const seated = new Set(seatedPlayers(all).map(nameOf));
    for (const p of list) {
      const lo = p.loadout || {}, L = p.record.levels || {};
      console.log(`${nameOf(p)}${seated.has(nameOf(p)) ? " [seated]" : ""} · style ${mainStyle(p)} · ${Object.entries(L).map(([k, v]) => `${k} ${v}`).join(", ")}`);
      console.log(`  gear: ${(lo.equipment || []).map(e => `${slotName(e.itemHrid)}=${short(e.itemHrid)}+${e.enhancementLevel || 0}`).join(", ")}`);
      console.log(`  abilities: ${(lo.abilities || []).map(a => `${short(a.hrid)}@${a.level}`).join(", ")}`);
      const trig = Object.entries(lo.abilityTriggers || {}).filter(([, v]) => v);
      if (flags.full) for (const [h, t] of trig) console.log(`    trigger ${short(h)}: ${t.map(c => `${short(c.dependencyHrid)} ${short(c.conditionHrid)} ${short(c.comparatorHrid)} ${c.value}`).join(" AND ")}`);
      else if (trig.length) console.log(`  custom triggers on: ${trig.map(([h]) => short(h)).join(", ")} (--full to show)`);
      console.log(`  food: ${(lo.food?.["/action_types/combat"] || []).map(f => short(f.itemHrid)).join(", ") || "-"} · drinks: ${(lo.drinks?.["/action_types/combat"] || []).map(f => short(f.itemHrid)).join(", ") || "-"}`);
      const owned = p.record?.owned?.abilities || p.owned?.abilities;
      if (owned?.length) console.log(`  owned abilities: ${owned.filter(a => a.level > 0).map(a => `${short(a.abilityHrid)}@${a.level}`).join(", ")}`);
      else console.log(`  owned abilities: not in this export (only the slotted ones are known)`);
      if (flags.full) console.log(`  rooms: ${Object.entries(p.record.rooms || {}).map(([k, v]) => `${short(k)} ${v}`).join(", ")}`);
    }
  },

  async seat() {
    const all = party(), s = settings();
    if (!pos[0] || pos[0] === "all") delete s.seat;
    else s.seat = pos[0].split(",").map(n => nameOf(findPlayer(all, n.trim())));
    writeState(SETTINGS_FILE, s);
    console.log(`seated: ${seatedPlayers(all).map(nameOf).join(", ")}`);
  },

  async zones() {
    let list = await zones();
    if (pos[0]) list = list.filter(z => norm(z.hrid).includes(norm(pos[0])) || norm(z.name).includes(norm(pos[0])) || norm(z.category).includes(norm(pos[0])));
    if (asJson) return out(list);
    for (const z of list) console.log(`${short(z.hrid).padEnd(28)} ${z.name.padEnd(26)} ${z.isDungeon ? "dungeon" : "planet "} party≤${z.maxPartySize} tiers 0-${z.maxDifficulty}  ${short(z.category)}`);
  },

  async catalog() {
    const cat = await catalog(), kind = pos[0], q = pos[1] ? norm(pos[1]) : "";
    const match = (...xs) => !q || xs.some(x => norm(x).includes(q));
    if (kind === "abilities") {
      const list = cat.abilities.filter(a => match(a.abilityHrid, a.name, ...(a.families || []), a.kind));
      if (asJson) return out(list);
      for (const a of list) console.log(`${short(a.abilityHrid).padEnd(24)} ${a.isSpecial ? "SPECIAL " : ""}${a.kind} [${(a.families || []).join("/")}] ${short(a.damageType)}${a.aoe ? " aoe" : ""} · mana ${a.manaCost} · cd ${a.cooldownSeconds}s · cast ${a.castSeconds}s`);
    } else if (kind === "food" || kind === "drinks") {
      const list = cat[kind].filter(f => match(f.itemHrid, f.name, f.family));
      if (asJson) return out(list);
      for (const f of list) console.log(`${short(f.itemHrid).padEnd(28)} lv${f.level} ${f.family || ""} hp+${f.hitpointRestore || 0} mp+${f.manapointRestore || 0} cd ${f.cooldownSeconds}s ${(f.buffs || []).map(b => `${short(b.typeHrid)} +${b.flatBoost || b.ratioBoost}`).join(" ")}`);
    } else if (kind === "items") {
      const list = (await allItems()).filter(i => match(i.itemHrid, i.name, i.slot));
      if (asJson) return out(list);
      for (const i of list) console.log(`${short(i.slot).padEnd(10)} ${short(i.itemHrid).padEnd(36)} lv${i.level}`);
    } else if (kind === "triggers") out(cat.triggers);
    else die("catalog <abilities|food|drinks|items|triggers> [filter]");
  },

  async config() {
    let s = settings();
    if (pos[0] === "reset") s = {};
    for (const kv of pos.filter(x => x !== "reset")) {
      const [k, ...rest] = kv.split("="), v = rest.join("=");
      if (k.startsWith("pricing.")) (s.pricing ||= {})[k.slice(8)] = v === "true" ? true : v === "false" ? false : v;
      else if (k === "buffs") s.buffs = v ? JSON.parse(v) : undefined;
      else if (k === "wave") s.wave = v === "" ? undefined : Number(v);
      else if (k === "seed") s.seed = Number(v);
      else if (k.startsWith("task.")) { const p = findPlayer(party(), k.slice(5)); (s.task ||= {})[nameOf(p)] = v ? `/monsters/${norm(v)}` : undefined; }
      else die(`unknown setting ${k}`);
    }
    if (pos.length) writeState(SETTINGS_FILE, s);
    out({ pricing: { ...PRICE_DEFAULTS, ...(s.pricing || {}) }, buffs: s.buffs ?? "(server default)", wave: s.wave ?? "(default)", seed: s.seed ?? 1, task: s.task || {}, seat: s.seat || "all" });
  },

  async run() {
    const o = await runOpts(24, 3);
    let players = clone(seatedPlayers(party(), flags.players));
    for (const m of multi.mod) players = await applyMods(players, m);
    const results = [];
    for (const z of o.zs) for (const t of o.tiers) {
      checkTier(z, t);
      progress(`running ${z.name} T${t}…`);
      try {
        const cands = await runSeeds(players, { zone: z.hrid, tier: t, hours: o.hours, seeds: o.seeds, seed0: o.seed0 });
        const { agg } = aggregate(cands);
        results.push({ zone: z.name, hrid: z.hrid, tier: t, ...agg, dungeon: z.isDungeon ? { completedPerHour: stats(cands.map(c => c.dungeonsCompletedPerHour)), failedPerHour: stats(cands.map(c => c.dungeonsFailedPerHour)), avgMinutes: stats(cands.map(c => c.averageDungeonMinutes)) } : null, detail: flags.detail || asJson ? playerDetail(cands) : undefined });
      } catch (e) { results.push({ zone: z.name, hrid: z.hrid, tier: t, error: String(e?.message || e) }); }
    }
    progressEnd();
    if (asJson) return out({ party: players.map(nameOf), hours: o.hours, seeds: o.seeds, seed: o.seed0, results });
    console.log(`party: ${players.map(nameOf).join(", ")} · ${o.hours} h × ${o.seeds} seeds (from ${o.seed0}) · ± is one standard error`);
    for (const r of results) {
      if (r.error) { console.log(`${r.zone} T${r.tier}: ERROR ${r.error}`); continue; }
      console.log(`${r.zone} T${r.tier}: XP/h ${pm(r.xp.mean, r.xp.se)} · profit/day ${pm(r.profit.mean, r.profit.se, 0, coins)} · kills/h ${pm(r.kills.mean, r.kills.se, 1)} · deaths/h ${pm(r.deaths.mean, r.deaths.se, 2)}${r.keys.mean ? ` · keys/h ${pm(r.keys.mean, r.keys.se, 2)}` : ""}${r.dungeon ? ` · runs/h ${fmt(r.dungeon.completedPerHour.mean, 2)} (failed ${fmt(r.dungeon.failedPerHour.mean, 2)}, ${fmt(r.dungeon.avgMinutes.mean, 1)} min)` : ""}`);
      if (r.detail) printDetail(r.detail);
    }
  },

  async compare() {
    const o = await runOpts(300, 4);
    if (o.zs.length !== 1 || o.tiers.length !== 1) die("compare takes one zone and one tier");
    const z = o.zs[0], t = o.tiers[0]; checkTier(z, t);
    const base = seatedPlayers(party(), flags.players);
    const specs = multi.variant.map((v, i) => { const at = v.indexOf(":"); return at > 0 && !v.slice(0, at).includes(".") ? { label: v.slice(0, at).trim(), mods: v.slice(at + 1) } : { label: `variant ${i + 1}`, mods: v }; });
    if (!specs.length) die("give at least one --variant \"label: mods\"");
    if (specs[0].mods.trim()) specs.unshift({ label: "current", mods: "" });
    const variants = [];
    for (const s of specs) variants.push({ ...s, players: await applyMods(clone(base), s.mods) });
    let done = 0;
    const runs = await Promise.all(variants.map(async v => {
      try { const c = await runSeeds(v.players, { zone: z.hrid, tier: t, hours: o.hours, seeds: o.seeds, seed0: o.seed0 }); progress(`${++done}/${variants.length} variants`); return { cands: c, ...aggregate(c) }; }
      catch (e) { return { error: String(e?.message || e) }; }
    }));
    progressEnd();
    const b = runs[0];
    const rows = variants.map((v, i) => {
      const r = runs[i]; if (r.error) return { label: v.label, mods: v.mods, error: r.error };
      const diff = {};
      if (b.sums) for (const k of METRICS) diff[k] = stats(r.sums.map((s, j) => s[k] - b.sums[j][k]));
      return { label: v.label, mods: v.mods, ...r.agg, vsBase: diff, detail: flags.detail || asJson ? playerDetail(r.cands) : undefined };
    });
    if (asJson) return out({ zone: z.name, tier: t, hours: o.hours, seeds: o.seeds, rows });
    console.log(`${z.name} T${t} · ${o.hours} h × ${o.seeds} seeds · Δ is the paired difference vs "${rows[0].label}" (± one SE; |Δ| > 2 SE is a real difference)`);
    for (const r of rows) {
      if (r.error) { console.log(`  ${r.label}: ERROR ${r.error}`); continue; }
      const d = (k, dd = 0, f = fmt) => r === rows[0] ? "" : ` (Δ ${pm(r.vsBase[k].mean, r.vsBase[k].se, dd, f)}${r.vsBase[k].se && Math.abs(r.vsBase[k].mean) > 2 * r.vsBase[k].se ? " *" : ""})`;
      console.log(`  ${r.label}: XP/h ${fmt(r.xp.mean)}${d("xp")} · profit/day ${coins(r.profit.mean)}${d("profit", 0, coins)} · kills/h ${fmt(r.kills.mean, 1)}${d("kills", 1)} · deaths/h ${fmt(r.deaths.mean, 2)}${d("deaths", 2)}`);
      if (r.detail) printDetail(r.detail);
    }
  },

  async "best-abilities"() {
    const o = await runOpts(300, 2);
    if (o.zs.length !== 1 || o.tiers.length !== 1) die("best-abilities takes one zone and one tier");
    const z = o.zs[0], t = o.tiers[0]; checkTier(z, t);
    const all = party(); if (!flags.player) die("--player is required");
    const who = findPlayer(all, flags.player), name = nameOf(who);
    const metric = ["xp", "profit", "kills"].includes(flags.metric) ? flags.metric : "xp";
    const cat = await catalog();
    const levels = ownedLevels(who);
    if (flags.levels && flags.levels !== true) for (const tok of String(flags.levels).split(",")) { const [n, l] = tok.split("@"); levels.set((await findAbility(n.trim())).abilityHrid, num(l, 0)); }
    const style = mainStyle(who);
    const fits = d => { const f = d.families || []; return !f.length || f.some(x => !["melee", "ranged", "magic"].includes(x)) || f.includes(style); };
    const only = flags.only && flags.only !== true ? new Set(await Promise.all(String(flags.only).split(",").map(async n => (await findAbility(n.trim())).abilityHrid))) : null;
    const excl = flags.exclude && flags.exclude !== true ? new Set(await Promise.all(String(flags.exclude).split(",").map(async n => (await findAbility(n.trim())).abilityHrid))) : new Set();
    const pool = cat.abilities.filter(d => (levels.get(d.abilityHrid) || 0) > 0 && (flags["no-fit"] || fits(d)) && (!only || only.has(d.abilityHrid)) && !excl.has(d.abilityHrid));
    const normal = pool.filter(d => !d.isSpecial).map(d => d.abilityHrid), special = pool.filter(d => d.isSpecial).map(d => d.abilityHrid);
    if (!pool.length) die("no abilities to try: the export lists none owned; give levels with --levels a@100,b@90");
    const intel = Number(who.record?.levels?.intelligence) || 1;
    const slots = flags.slots != null && flags.slots !== true ? Math.min(4, Math.max(0, Math.floor(num(flags.slots, 0)))) : SLOT_INT.filter(l => intel >= l).length;
    const k = Math.min(slots, normal.length);
    const seated = seatedPlayers(all, flags.players), team = seated.some(p => nameOf(p) === name) ? seated : [who];
    if (team.length > z.maxPartySize) die(`${z.name} seats ${z.maxPartySize}; the party is ${team.length} (use --players or seat)`);
    let count = 1; for (let i = 0; i < k; i++) count = count * (normal.length - i) / (i + 1);
    count = Math.round(count) * Math.max(1, special.length);
    const max = num(flags.max, 300), mode = count <= max ? "all" : "local";
    const cur = (who.loadout?.abilities || []).map(a => a?.hrid).filter(Boolean);
    const start = { special: cur.find(h => special.includes(h)) || special[0] || null, normal: cur.filter(h => normal.includes(h)).slice(0, k) };
    const keyOf = s => `${s.special || ""}|${[...s.normal].sort().join(",")}`;
    const label = s => [s.special && `★${short(s.special)}@${levels.get(s.special)}`, ...s.normal.map(h => `${short(h)}@${levels.get(h)}`)].filter(Boolean).join(", ");

    const loadoutFor = async set => {
      const q = clone(who), list = [set.special, ...set.normal].filter(Boolean).map(h => ({ hrid: h, level: Math.max(1, levels.get(h) || 1) }));
      await setAbilities(q, list); return q;
    };
    const per = new Map();
    let done = 0, total = 0;
    const evalSets = async sets => {
      const fresh = sets.filter(s => !per.has(keyOf(s)));
      for (const s of fresh) per.set(keyOf(s), { set: s, runs: null, error: null });
      total += fresh.length;
      await Promise.all(fresh.map(async s => {
        const e = per.get(keyOf(s));
        const q = await loadoutFor(s), players = team.map(p => nameOf(p) === name ? q : p);
        try { e.runs = (await runSeeds(players, { zone: z.hrid, tier: t, hours: o.hours, seeds: o.seeds, seed0: o.seed0 })).map(summary); }
        catch (err) { e.error = String(err?.message || err); }
        progress(`${++done}/${total} sets`);
      }));
    };
    const score = s => { const e = per.get(keyOf(s)); return e?.runs ? stats(e.runs.map(r => r[metric])).mean : null; };
    const paired = (a, b) => { const ea = per.get(keyOf(a)), eb = per.get(keyOf(b));
      return ea?.runs && eb?.runs ? stats(ea.runs.map((r, i) => r[metric] - eb.runs[i][metric])) : null; };
    const steps = [];
    let held = null;
    if (mode === "all") {
      const sets = [], pick = (from, left, acc) => {
        if (!left) { for (const sp of special.length ? special : [null]) sets.push({ special: sp, normal: acc }); return; }
        for (let i = from; i <= normal.length - left; i++) pick(i + 1, left - 1, [...acc, normal[i]]);
      };
      pick(0, k, []);
      await evalSets(sets);
    } else {
      let curSet = start; await evalSets([curSet]);
      for (let round = 1; round <= 12; round++) {
        const have = new Set(curSet.normal), nb = [];
        curSet.normal.forEach((_, i) => { for (const h of normal) if (!have.has(h)) nb.push({ special: curSet.special, normal: curSet.normal.map((x, j) => j === i ? h : x) }); });
        if (curSet.normal.length < k) for (const h of normal) if (!have.has(h)) nb.push({ special: curSet.special, normal: [...curSet.normal, h] });
        for (const sp of special) if (sp !== curSet.special) nb.push({ special: sp, normal: curSet.normal });
        await evalSets(nb);
        let best = curSet, bv = score(curSet) ?? -Infinity;
        for (const x of nb) { const v = score(x); if (v != null && v > bv) { best = x; bv = v; } }
        if (best === curSet) break;
        const d = paired(best, curSet);
        if (d && d.se != null && d.mean <= 2 * d.se) { held = { round, to: label(best), gain: d.mean, noise: 2 * d.se }; break; }
        steps.push({ round, from: label(curSet), to: label(best), gain: bv - (score(curSet) ?? 0) });
        curSet = best;
      }
    }
    progressEnd();
    const startKey = keyOf(start);
    const rows = [...per.values()].map(e => {
      if (!e.runs) return { set: label(e.set), error: e.error };
      const r = { set: label(e.set), abilities: [e.set.special, ...e.set.normal].filter(Boolean).map(h => ({ hrid: h, level: levels.get(h) })), current: keyOf(e.set) === startKey };
      for (const m of ["xp", "profit", "kills", "deaths"]) r[m] = stats(e.runs.map(x => x[m]));
      r._set = e.set;
      return r;
    }).sort((a, b) => (b[metric]?.mean ?? -Infinity) - (a[metric]?.mean ?? -Infinity));
    const best = rows.find(r => !r.error);
    const bestSet = best?._set;
    for (const r of rows) if (r._set) { if (bestSet) r.vsBest = paired(r._set, bestSet); delete r._set; }
    const res = { player: name, zone: z.name, tier: t, metric, hours: o.hours, seeds: o.seeds, mode, sets: count, slots, style, party: team.map(nameOf), steps, held, rows };
    if (asJson) return out(res);
    console.log(`${name} on ${z.name} T${t} · best by ${metric} · ${o.hours} h × ${o.seeds} seeds · ${slots} normal slot(s) + special · ${count} possible sets, ${mode === "all" ? "all run" : `local search (${per.size} run)`}`);
    console.log(`party: ${team.map(nameOf).join(", ")} · pool: ${pool.map(d => `${short(d.abilityHrid)}@${levels.get(d.abilityHrid)}`).join(", ")}`);
    const top = rows.slice(0, num(flags.top, 15));
    top.forEach((r, i) => {
      if (r.error) return console.log(`${String(i + 1).padStart(3)}. ${r.set}: ERROR ${r.error}`);
      const vs = i && r.vsBest ? ` · vs best ${pm(r.vsBest.mean, r.vsBest.se, 0, metric === "profit" ? coins : fmt)}` : "";
      console.log(`${String(i + 1).padStart(3)}. ${r.set}${r.current ? "  [current]" : ""}\n     XP/h ${pm(r.xp.mean, r.xp.se)} · profit/day ${pm(r.profit.mean, r.profit.se, 0, coins)} · kills/h ${fmt(r.kills.mean, 1)} · deaths/h ${fmt(r.deaths.mean, 2)}${vs}`);
    });
    if (rows.length > top.length) console.log(`   … ${rows.length - top.length} more (--top N, or --json)`);
    for (const s of steps) console.log(`round ${s.round}: ${s.from} → ${s.to} (+${fmt(s.gain)} ${metric})`);
    if (held) console.log(`stopped at round ${held.round}: best swap (${held.to}) gained ${fmt(held.gain)}, within noise (2 SE = ${fmt(held.noise)})`);
    if (flags.apply && best && !best.error) {
      const q = clone(who); await setAbilities(q, best.abilities.map(a => ({ hrid: a.hrid, level: Math.max(1, a.level || 1) })));
      writeState(PARTY_FILE, all.map(p => nameOf(p) === name ? q : p));
      console.log(`applied #1 to ${name} in local/.state/party.json`);
    }
    if (rows[1] && rows[1].vsBest && rows[1].vsBest.se != null) {
      const d = -rows[1].vsBest.mean, n2 = 2 * rows[1].vsBest.se;
      console.log(d > n2 ? `verdict: #1 beats #2 by ${fmt(d)} ${metric} (> 2 SE ${fmt(n2)}): a clear winner.` : `verdict: #1 and #2 are within noise (${fmt(d)} vs 2 SE ${fmt(n2)}); add --seeds or --hours to separate them.`);
    }
  },

  async upgrades() { await optimizer("upgrades"); },
  async triggers() { await optimizer("triggers"); },
  async skills() { await optimizer("skills"); },

  async raw() {
    const method = pos[0]; if (!method) die("raw <method> [body.json|-]");
    const body = pos[1] ? JSON.parse(pos[1] === "-" ? readFileSync(0, "utf8") : readFileSync(pos[1], "utf8")) : undefined;
    const fn = client()[method]; if (typeof fn !== "function") die(`no method ${method}`);
    out(await fn(body));
  },
};

async function optimizer(kind) {
  const o = await runOpts(kind === "upgrades" ? 1500 : kind === "triggers" ? 2000 : 1000, 3);
  const z = o.zs[0], t = o.tiers[0]; checkTier(z, t);
  const players = withTasks(seatedPlayers(party(), flags.players));
  const lim = await client().zoneLimits(), s = settings();
  const body = { players, zone: z.hrid, difficultyTier: t, hours: o.hours, seeds: o.seeds, budgetMinutes: num(flags.minutes, null), accountBuffs: s.buffs || null };
  if (s.wave != null) body.waveTransitionDelayMs = s.wave;
  if (flags.player) body.player = nameOf(findPlayer(players, flags.player));
  const metric = flags.metric === "profit" ? "profit" : "xp";
  if (kind === "upgrades") Object.assign(body, { ...lim.upgrades, ...body, goal: { metric }, budget: lim.upgrades?.budget ?? null });
  if (kind === "triggers") Object.assign(body, { passes: num(flags.passes, 4), scope: flags.scope === "food" ? "food" : "abilities", goal: { metric } });
  if (kind === "skills") Object.assign(body, { horizonDays: num(flags.days, 90), points: num(flags.points, 10), charm: "current", charmLevel: 0 });
  if (flags.body && flags.body !== true) Object.assign(body, JSON.parse(readFileSync(flags.body, "utf8")));
  const rows = new Map(), stepsSeen = [];
  let head = null;
  const s0 = Date.now();
  const st = client().stream(kind, body, {
    onHead: h => { head = h; },
    onRow: r => { rows.set(r.index, r); progress(`${kind}: ${rows.size} rows · ${Math.round((Date.now() - s0) / 1000)} s`); },
    onStep: x => { stepsSeen.push(x); if (!asJson && kind === "triggers") { progressEnd(); console.log(`pass ${x.pass} · ${x.player} ${x.abilityName || short(x.itemHrid || x.abilityHrid)} #${x.triggerIndex} (${x.condition}): ${x.from} → ${x.to}${x.changed ? "" : " (kept)"} · Δ XP/h ${pm(x.deltaXp, x.deltaXpSE)} · Δ profit/day ${coins(24 * x.deltaProfit)}`); } },
  });
  process.on("SIGINT", () => { st.abort(); });
  const done = await st.done;
  progressEnd();
  const result = { head, rows: [...rows.values()], steps: stepsSeen, done };
  const file = flags.out && flags.out !== true ? flags.out : new URL(`${kind}-result.json`, STATE_DIR);
  mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(file, JSON.stringify(result, null, 2));
  if (asJson) return out(result);
  console.log(`${kind} on ${z.name} T${t}: ${rows.size} rows, ${Math.round((Date.now() - s0) / 1000)} s${done?.stopped ? " (stopped)" : ""} · full result: ${file instanceof URL ? file.pathname.replace(/^\/([A-Z]:)/, "$1") : file}`);
  const top = num(flags.top, 15);
  if (kind === "upgrades") {
    const by = metric === "profit" ? "perMillionCoinsProfit" : "perMillionCoinsXp";
    const ups = result.rows.map(r => r.upgrade).filter(u => u?.ok !== false).sort((a, b) => (b[by] ?? -Infinity) - (a[by] ?? -Infinity));
    console.log(`ranked by ${metric} gained per million coins (Δ ± one SE):`);
    for (const u of ups.slice(0, top))
      console.log(`  ${u.player} · ${u.kind} ${u.name}${u.from != null ? ` ${u.from}→${u.to}` : ""} · cost ${coins(u.cost?.coins)} · Δ XP/h ${pm(u.deltaXp, u.deltaXpSE)} · Δ profit/day ${coins(24 * u.deltaProfit)} · per 1M: ${fmt(u[by], 2)} (${u.seeds} seeds)`);
  } else if (kind === "triggers") {
    for (const c of done.changes || []) console.log(`  change: ${c.player} ${c.abilityName || short(c.itemHrid || c.abilityHrid)} #${c.triggerIndex} ${c.condition} ${c.from} → ${c.to}`);
    const cb = done.combined;
    if (cb) console.log(`  all changes together: Δ XP/h ${pm(cb.deltaXp, cb.deltaXpSE)} · Δ profit/day ${coins(24 * cb.deltaProfit)}`);
    if (flags.apply && Array.isArray(done.players)) {
      const all = party(), byName = new Map(done.players.map(p => [nameOf(p), p]));
      writeState(PARTY_FILE, all.map(p => byName.has(nameOf(p)) ? { ...p, loadout: byName.get(nameOf(p)).loadout } : p));
      console.log(`  applied to local/.state/party.json`);
    } else if ((done.changes || []).length) console.log(`  (--apply writes these into the party)`);
  } else {
    for (const r of (done.ranked || result.rows).slice(0, top)) console.log(" ", JSON.stringify(r.row || r).slice(0, 500));
  }
}

const run = commands[cmd] || (!cmd || cmd === "--help" || cmd === "-h" ? commands.help : null);
if (!run) die(`unknown command "${cmd}" (try: help)`);
try { await run(); }
catch (e) { die(String(e?.message || e).replace(/^\d{3}\s*/, "")); }
finally { zoneClient?.close(); }
