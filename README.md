# Metz Combat Simulator

A combat simulator for [Milky Way Idle](https://www.milkywayidle.com/) planets and dungeons that runs entirely in
your browser: <https://metzlii.github.io/metz-combat-simulator/>

- **Simulate** a character or a whole party in any planet or dungeon, at any tier, for as many simulated hours as you
  like: kills, deaths, XP, loot and profit per hour.
- **Optimize:**
  - **Upgrades:** the gear and ability upgrades worth the most per coin, priced through enhancing, mirrors and books.
  - **Trigger values:** your abilities' enemy-HP thresholds, tuned two passes deep.
  - **Skill levelling:** which combat skill repays its levelling time, drawn as curves over the days it takes.
- **Import a whole party at once** with the [MWI Party Export](https://greasyfork.org/en/scripts/596494-mwi-party-export)
  userscript: open each member's profile once, then paste.

Nothing is sent to a server: the combat kernel is compiled to WebAssembly and every simulation runs on your machine.

## This repository

This repository holds the **built site only**: what GitHub Pages serves. The source is kept in a private repository,
and each release replaces this one's contents with a new build. Issues and suggestions are welcome here.

## Local mode (this fork)

Run the simulations in Node on your PC instead of in browser Web Workers. It needs [Node.js](https://nodejs.org/)
18 or newer and nothing else.

```
node local/server.mjs            # or double-click local/start.cmd on Windows
```

This opens the same page at <http://localhost:8787/>. The page is only the UI: every simulation runs in Node worker
threads on all of your cores, without the browser's core-count limits or background-tab throttling. Options:
`--port N`, `--workers N` (defaults to every core), `--no-open` and `--no-split` (below). The market price cache is kept in
`local/.cache/`. Opened any other way (for example from GitHub Pages), the page runs in the browser as before.

**Split sims.** A Run with fewer zones than threads would leave most cores idle, so each planet sim in it runs as
chunks of at least 3 h on separate threads (a single 168 h sim: 1.2 s → 0.3 s on 8 cores / 16 threads). Every
chunk after the first starts with a 1–2 h warm-up that is simulated and then subtracted, so no chunk starts from a
fresh full-mana, nothing-on-cooldown state. Over 32 seeds on solo and party zones, the split results differed from
unsplit ones by no more than unsplit runs on other seeds do (within ±0.11% on kills, XP, damage, consumables and
mana). Each chunk has its own seed, so the numbers are an equally valid sample, not the browser's exact ones; the
same request always gives the same numbers. Dungeons, the upgrade / trigger / skill searches (which fill every
thread already) and Runs with many zones are never split. `--no-split` turns it off.

### Measuring performance

- **Live dashboard:** <http://localhost:8787/local/dashboard.html> shows throughput (simulated hours and
  simulations per second), how many cores are busy in the kernel, per-thread utilization, kernel ms per simulated
  hour (p50/p95), queue, CPU and memory for the last ten minutes, plus the latest simulations. "Run load test"
  puts a fixed workload through the pool, and the Workers field resizes the pool live.
- **Scaling benchmark:** `node local/bench.mjs` runs the same workload at 1, 2, 4… workers and prints throughput,
  speedup and efficiency per worker count (`--workers 1,8,16`, `--hours 24`, `--repeat 3`).
- **Prometheus / Grafana:** the server exposes <http://localhost:8787/metrics>. With Docker Desktop running,
  `docker compose -f local/grafana/docker-compose.yml up -d` starts Prometheus and Grafana with a ready-made
  dashboard at <http://localhost:3000>, keeping 30 days of history.

## Best combination of loadouts (this fork)

On Setup, under the loadout editor: give a character several loadouts and find which loadout of each makes the best
party. A second export of a character imports as "Name (2)". Paste it with the others, or use the panel's **Add
loadouts** box, which appends to the party instead of replacing it. Players are grouped into characters by name; a
dropdown per loadout regroups one, for example a player made with Add player. Each loadout can be given a name
("Ranged", "Nature"), which the ranking and the party card show. Mark each character *In the party*,
*Optional* (also tried sitting out) or *Left out*, pick any zone (planet or dungeon, queued or not), its tier, hours and seeds, and Run. Every combination
that fits the zone's party size runs on the same seeds. They are ranked by XP / h, Profit / day, Kills / h or Keys / h
(key fragments the whole party earns), with two standard errors, and **Seat** puts a combination in the party for a
full Run.

**Keys.** Tick *Find the tier that earns the most keys* to search the tiers as well: the Tier field goes away
and every combination is ranked at every tier where it is worth running. T0 is never run, since no key fragment drops
there. The search climbs from T1 one tier at a time, and a combination stops at the first tier where it earns fewer
keys than at the tier below (the monsters have outpaced the higher drop rate: slower kills, deaths, wipes), so tiers
too strong for every combination are never simulated. **Seat** also queues the zone at the winning tier.
Dungeons drop chests, not keys, so on a dungeon the box does nothing.

## Best abilities (this fork)

On Setup, under Best combination: find which of a character's abilities fill their slots best. Pick the player and
give every ability its level (0 or empty: not learned). The export's owned abilities and the loadout fill the table
in; a level typed here is kept per character and marked, and **Back to export levels** forgets them. By default only
abilities that fit the character's style are tried (no Fireball on a bow). The normal slots follow Intelligence (one
at 1, then 20, 50 and 90) plus the special slot, or can be set by hand. Pick the zone, tier, hours and seeds, and
whether the best is the most XP / h, Profit / day or Kills / h.

The rest of the seated party stays as it is (a player who is not seated runs alone), and every set runs on the same
seeds. Up to 300 sets, **every** set is run. Past that, the search starts from the loadout's own abilities and each
round runs every single swap (one normal slot takes another ability, an empty slot is filled, another special goes
in). It takes the best swap only when it beats the current set by more than twice the standard error of the paired
per-seed differences, and stops when none does. The ranking lists every set run, with the rounds taken below it.
**Apply** puts a set in the player's loadout at the levels it ran with: an ability that stays keeps its trigger
conditions, and one that comes in starts on its defaults.

## Found something wrong?

Mail Metzli in-game, or open an issue. Numbers that look off are worth reporting with your export and the zone you
ran: a seed makes a run reproducible.

## Credits

- The combat kernel is a Rust port of the community MWI Combat Simulator (AmVoidGuy, shykai, azhu949), by gragatrim,
  used with permission, and further optimized by Metzli: 4–9× faster per simulation, with identical results.
- Weylan measured the gap between one fight ending and the next starting, on planets.
- Star wrote the core-count probe, so a browser that hides how many cores you have no longer costs you lanes.
- Kim, Mango and Zhiwen provided test data.
- Enhancement costs follow [Enhancelator](https://github.com/doh-nuts/Enhancelator) by doh-nuts.

Full licence texts are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Game data and art belong to Milky Way
Idle.

## Licence

MIT: see [LICENSE](LICENSE).
