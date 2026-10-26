# Answering MWI questions with the simulator

The user asks things like "which abilities should I use", "is X better than Y", "where should I farm", "what to
upgrade next". Answer them by simulating, through the command-line front end `local/mwi.mjs` (run from the repo
root; `node local/mwi.mjs help` lists everything). It runs the same kernel and zone API as the page, in Node
worker threads, so its numbers are the page's.

## Workflow

1. **Get the party.** The user pastes an MWI Party Export (userscript output) or a sim export. Save it to a file
   and `node local/mwi.mjs import <file>` (`--add` to append a second loadout). It lands in
   `local/.state/party.json`, which stays between sessions: check `party` before asking for a new export.
   The import warns when the export has no owned inventory: then only the *slotted* abilities' levels are known,
   so ask for the other ability levels (or take them as `--levels a@100,b@90`).
   Saved loadouts (`local/.state/loadouts.json`) keep characters between exports: `import` saves each player
   under its name, `save <label>` stores the party under a label, `loadouts` lists them, `load <label,...>`
   brings them back, and the mod `A.loadout=saved:<label>` compares a saved setup against the current one.
   Check `loadouts` before asking the user for an export.
2. **Look.** `party [name] [--full]`, `zones [filter]`, `catalog abilities|food|drinks|items [filter]`.
3. **Simulate.**
   - `run --zone Z --tier T [--detail]`: baseline numbers. `--detail` shows casts / h, damage by source, mana
     (mean, % dry, casts lost to mana), damage taken, consumables, loot: use it to explain *why*.
   - `compare --zone Z --variant "label: Player.mod=...; ..."`: what-ifs on the same seeds, with the paired
     difference to the base. A `*` marks a difference over 2 SE; anything else is noise.
   - `best-abilities --player A --zone Z [--metric xp|profit|kills]`: every ability set (or a local search when
     there are too many).
   - `triggers`, `upgrades`, `skills`: the page's optimizers (slow: minutes). Full results go to
     `local/.state/<kind>-result.json`.
4. **Apply** only when the user wants it: `best-abilities --apply`, `triggers --apply`, or edit
   `party.json` by hand (it is plain JSON).

## Judging results

- Each seed is an independent sample; `±` is one standard error. Use enough hours and seeds that the gap you
  report is over 2 SE (compare marks it). Quick look: `--hours 50 --seeds 3`. Real answer: 300+ h, 4+ seeds.
  Planet runs are fast (a few seconds); dungeons and big parties are slower.
- Mention deaths / h: a set that dies is not the best even if the XP looks good.
- An ability with a custom trigger that never fires shows 0 casts in `--detail`: say so, and suggest
  `triggers` rather than concluding the ability is useless. New abilities put in by a mod start on their
  default triggers.
- Profit depends on live market prices (fetched and cached in `local/.cache/`), and pricing settings live in
  `config` (`pricing.loot=bid|ask`, ...). Say which metric an answer optimizes.
- Tasks (`config task.Player=monster`) and seated players (`seat`) change the runs; check `config` if numbers
  look odd.
