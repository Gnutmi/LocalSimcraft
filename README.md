# simlocal

A local Raidbots-style web UI for [SimulationCraft](https://github.com/simulationcraft/simc). Runs on your machine, uses your CPU, no queue, no daily quota, no Pro subscription. Hit it from any device on your LAN.

Built for the use case of "I do a lot of sims and don't want to keep paying for Pro."

## What it does

- **Quick Sim** — paste an addon export, get a full SimC HTML report.
- **Droptimizer** — give it a list of candidate items, it sims each one as a profileset and shows you the DPS gain per item. Rings and trinkets are auto-tested in both slots.
- **Top Gear** — pastes that include bag items (the SimC addon has a checkbox for this) get every bag item tested as a swap, ranked by DPS gain.

All sims run through SimC's native profileset feature, so the HTML reports look exactly like vanilla SimC's — because that's what they are. There's also a parsed results table in the web UI so you can rank candidates without opening the report.

## Prerequisites

1. **Node.js 18 or newer.** [Download here.](https://nodejs.org/)
2. **SimulationCraft.** Grab the latest nightly from <https://www.simulationcraft.org/download.html> and unzip it somewhere stable, e.g. `C:\SimulationCraft\`.

## Install

```powershell
# in PowerShell, from wherever you unzipped this
cd simlocal
npm install
```

## Configure

Tell simlocal where your `simc.exe` lives. Two ways:

**Option A — environment variable (one-shot):**
```powershell
$env:SIMC_PATH = "C:\SimulationCraft\simc.exe"
npm start
```

**Option B — copy `.env.example` to `.env`** and edit the values, then run `npm start`. (The server reads `SIMC_PATH`, `PORT`, and `HOST` from the environment; `.env` files aren't auto-loaded, so on Windows the simplest path is the launcher script below.)

**Option C — create a launcher script.** Save this as `start.cmd` next to `server.js`:
```cmd
@echo off
set SIMC_PATH=C:\SimulationCraft\simc.exe
set PORT=3737
node server.js
```
Double-click `start.cmd` to launch.

If `SIMC_PATH` isn't set, the server will guess `C:\SimulationCraft\simc.exe` on Windows. The status pill in the top-left of the UI tells you whether it found the binary.

## Use

1. Start the server: `npm start` (or run `start.cmd`).
2. Open <http://localhost:3737> in your browser.
3. Other devices on your LAN can hit it at `http://<your-pc-ip>:3737`.
4. In WoW, run `/simc` to open the addon, copy the export, paste into the form.

### Tips

- **Iterations:** 10,000 is the default and matches Raidbots' free tier. 25,000 matches Raidbots Pro. Higher = lower variance, longer wait.
- **Threads:** leave blank to use all CPU cores. If you want to keep playing while sims run, set this to `cores - 2`.
- **Top Gear:** before exporting from the addon, tick the "Show Bag Items" checkbox. Without that, the export has no bag data and Top Gear has nothing to swap.
- **Droptimizer items:** the easiest way to build the candidate list is to copy gear lines from a fresh addon export, swap the IDs to the items you want to test, and paste them in. The format is `slot=,id=NNNN,bonus_id=A/B/C` — anything after a `#` on the line is treated as a comment / display label.

### Where things live

- `reports/<job-id>/report.html` — the SimC HTML report
- `reports/<job-id>/input.simc` — the exact .simc file that was fed to simc.exe (handy for debugging or re-running by hand)
- `reports/<job-id>/simc.log` — full simc stdout/stderr
- `jobs/*.json` — job metadata (so history survives a restart)

You can safely delete anything in `reports/` and `jobs/` if you want to clean up.

## Architecture

```
browser  ──HTTP──▶  Express  ──spawn──▶  simc.exe
   ▲                   │
   └──── WebSocket ────┘   (live progress + DPS lines)
```

- One sim runs at a time. They're CPU-bound; running two in parallel would just halve your iterations/sec without giving you results faster.
- Job metadata is persisted to `jobs/*.json` so the history list survives restarts.
- The frontend is a single-file SPA in `public/index.html` (no build step, no framework — open it and it works).

## Limitations & honest comparisons to Raidbots

- **No item database.** Raidbots maintains curated drop lists per raid/dungeon. You provide the list of items to test. Building a Wowhead scraper to populate this automatically is a reasonable next step but not in the box.
- **Top Gear is single-swap, not combinatorial.** Raidbots tests combinations of bag items across multiple slots; this version tests each bag item as a one-slot swap against your current gear. For most cases (single best-in-slot per piece) this is what you want anyway.
- **No login, no auth, no rate limiting.** This is a LAN tool. Don't expose it to the internet.
- **No queue across runs.** Submit one job, it runs. Submit two, they run sequentially.

## Extending

Common next steps if you want to push it further:

- **Curated drop lists per raid.** Drop a JSON file in `data/` keyed by encounter, hook a dropdown into the Droptimizer form, populate the candidates textarea from the selection.
- **Combinatorial Top Gear.** Generate `Cartesian × slots` profilesets with a sane cap (Raidbots caps at ~1000). The `buildTopGear` function in `lib/profilesets.js` is the place.
- **Stat weights.** SimC has `calculate_scale_factors=1` — wire up a fourth tab.
- **Persistent profiles.** Stash recent profiles in localStorage so you don't have to repaste every time.

## License

MIT.
