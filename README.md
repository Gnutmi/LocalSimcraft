# LocalSimcraft

A local, web-based UI for [SimulationCraft](https://github.com/simulationcraft/simc) — like [Raidbots](https://www.raidbots.com/) but running on your own machine. No daily quotas, no Pro subscription, no waiting in queues. Paste your character export, hit Run, get results.

Use it from any device on your home network: sim from your phone while the desktop does the work.

## Features

- **Quick Sim** — paste your `/simc` export, get a full SimC HTML report.
- **Droptimizer** — give it a list of items that might drop, see how much DPS each one is worth as an upgrade. Rings and trinkets are auto-tested in both slots.
- **Top Gear** — paste an export with bag items included, see which bag piece (if any) beats what's currently equipped, ranked.
- **Auto-skip** — items SimC can't handle (wrong armor type for your class, items newer than your simc binary, broken bonus IDs) get skipped automatically with a clear log entry. No more entire sims dying on a single bad item.
- **Live progress** — watch sims run in real time. Job history persists across server restarts.
- **LAN-friendly** — bind to `0.0.0.0` by default; reach the server from any device on your network.

## Setup (Windows)

This is the happy path. Five steps, ~10 minutes if you don't already have Node.

### 1. Install Node.js

Download the **LTS** version from <https://nodejs.org/> and run the installer. Defaults are fine. This adds `node` and `npm` to your PATH.

Verify in a fresh PowerShell window:
```powershell
node -v
```
Should print something like `v22.x.x`.

### 2. Install SimulationCraft

Grab the latest **Windows nightly** from <https://www.simulationcraft.org/download.html>. It's a `.7z` archive — install [7-Zip](https://www.7-zip.org/) if you don't have an extractor.

Extract somewhere with a simple, stable path. Wherever you put it, **remember the path** — you'll plug it into `start.cmd` in a moment. **Avoid paths with spaces** (no `Program Files`) and **avoid OneDrive/Dropbox folders** — sync can corrupt running processes.

Common choices: `C:\SimulationCraft\`, `D:\Games\SimulationCraft\`, or your own preference.

After extraction you should see `simc.exe` and `SimulationCraft.exe` directly inside the chosen folder. We only use `simc.exe`.

### 3. Get LocalSimcraft

Either clone with git:
```powershell
git clone https://github.com/Gnutmi/LocalSimcraft.git
cd LocalSimcraft
```

…or click the green **Code** button on the GitHub page → **Download ZIP**, then unzip.

Either way, put it somewhere you'll remember (e.g. `C:\Users\<you>\Code\LocalSimcraft\`). Avoid OneDrive/Dropbox here too.

### 4. Edit `start.cmd` to match your install

This is the only configuration step, and it's important — **the path in `start.cmd` reflects the original author's setup, not yours**.

Open `start.cmd` in Notepad (right-click → Edit). The top of the file looks like this:

```cmd
set "SIMC_PATH=I:\Simulationcraft\simc.exe"
set "PORT=3737"
set "HOST=0.0.0.0"
```

**Change the `SIMC_PATH` line to point at wherever you extracted SimulationCraft.** A few examples of what yours might look like:

- `set "SIMC_PATH=C:\SimulationCraft\simc.exe"` (the most common location)
- `set "SIMC_PATH=D:\Games\SimulationCraft\simc.exe"`
- `set "SIMC_PATH=C:\Tools\simc-1230-01-win64\simc.exe"`

The path must point at the `simc.exe` file itself, not the folder containing it.

Save and close. You probably don't need to touch `PORT` or `HOST` — see [Configuration](#configuration) below if you do.

### 5. Run it

Double-click `start.cmd`.

The first time, it'll spend a minute installing dependencies (`npm install`). Subsequent launches skip this and boot in seconds.

When you see:
```
  LocalSimcraft listening on http://localhost:3737
```

…open <http://localhost:3737> in your browser. The status pill in the top-left should be green ("simc ready · N cores").

That's it.

**Pin it for one-click launch:** right-click `start.cmd` → "Pin to Start" or "Create shortcut" → drag the shortcut to your taskbar.

## Your first sim

1. In WoW, type `/simc` to open the SimulationCraft addon.
2. **For Top Gear**, tick the **"Show Bag Items"** checkbox first. Without this, your bag contents aren't included and Top Gear has nothing to compare against.
3. Click **Copy** to copy the export to your clipboard.
4. In your browser at <http://localhost:3737>, click the tab you want (Quick Sim / Droptimizer / Top Gear).
5. Paste the export into the textarea, hit **Run sim**.
6. Watch the live log. When status flips to "done" (green), the **Profileset results** section shows the ranked DPS table.

**How to read the Top Gear results:**

| Profileset | DPS | Δ vs baseline | % change |
|---|---|---|---|
| baseline (your current gear) | 1,250,400 | — | — |
| Heart of Conviction (619) [trinket1] | 1,287,300 | +36,900 | +2.95% |
| Mereldar's Toll (613) [trinket1] | 1,261,500 | +11,100 | +0.89% |
| Robe of Forgotten Promises (610) | 1,243,100 | -7,300 | -0.58% |

Anything with a green positive delta is an upgrade. The `[trinket1]` / `[trinket2]` tag tells you which existing piece to swap. Top of the list = biggest gain.

For Droptimizer, paste candidate items as one-per-line in SimC gear-line format (`slot=,id=NNNN,bonus_id=A/B/C`). Easiest source: copy lines from a fresh addon export and edit the IDs.

## Troubleshooting

### "simc not found" / red status pill

The SIMC_PATH in `start.cmd` doesn't point at a real `simc.exe`. Open `start.cmd` in Notepad, fix the path, save, relaunch.

To verify the path: open File Explorer to whatever `SIMC_PATH` is set to. If `simc.exe` isn't there, you've got the wrong path.

### Baseline DPS is suspiciously low (e.g. 100k for a current-content character)

Three usual suspects:

1. **Wrong spec was active when you ran `/simc`.** The addon exports your *current* spec. Make sure you're in your DPS spec, not your healing/tank spec.
2. **Your simc.exe is older than the addon.** The addon export header tells you the minimum simc version it needs ("Requires SimulationCraft NNN-NN or newer"). If your simc is older, mechanics may not parse correctly.  
   **Fix:** redownload from <https://www.simulationcraft.org/download.html> and replace the contents of your simc folder.
3. **As a sanity check**, paste the same export into the standalone `SimulationCraft.exe` GUI. If it gives the same low number, the issue is in your profile or simc itself, not LocalSimcraft.

### Top Gear shows no bag items / "0 swaps"

You forgot to tick **"Show Bag Items"** in the SimC addon before exporting. Re-export with that checkbox ticked.

If you ticked it but still see no bag items, the addon might have changed its output format. Open an issue or paste your export and we can update the parser.

### Some bag items missing from results

LocalSimcraft auto-skips items SimC can't sim (wrong armor type, items newer than your simc binary's data, broken bonus IDs, etc.). Check the live log for entries like:

```
[auto-skip] Removing 1 bad item(s); retrying… (Parasite Stompers (263))
[auto-skip] Final tally: 1 item(s) excluded — "Parasite Stompers (263)".
```

If a real upgrade got skipped, **update simc.exe** — it's almost always an item the binary's database doesn't know about yet. After updating, re-run.

### Sim hangs / no progress

Watch the live log. SimC sometimes takes a long time on the first iteration when warming up. If progress is genuinely stuck for 5+ minutes:

1. Check `reports/<job-id>/simc.log` for errors.
2. Cancel by closing the start.cmd window.
3. Retry with fewer iterations (e.g. 1000) to see if simc itself is the problem.

### "Updates were rejected" when pushing in GitFork

You probably have the GitHub-side repo with a README/license that conflicts with your local commits. Run in GitFork's terminal:
```
git pull origin main --allow-unrelated-histories
```
Resolve any conflicts, commit, push.

### Port 3737 already in use

Edit `start.cmd`, change `set "PORT=3737"` to a different port (e.g. `3838`). Save, relaunch, browse to the new port.

## Configuration

`start.cmd` exposes three knobs at the top:

| Variable | Default in repo | Purpose |
|---|---|---|
| `SIMC_PATH` | `I:\Simulationcraft\simc.exe` | Absolute path to your simc binary. Must point at the file, not the folder. **You almost certainly need to change this for your machine.** |
| `PORT` | `3737` | HTTP port the server listens on. |
| `HOST` | `0.0.0.0` | Bind address. `0.0.0.0` = reachable from your LAN. `127.0.0.1` = local-only. |

LAN access is on by default. Find your machine's IP with `ipconfig` (Windows) and other devices can hit `http://<your-ip>:3737/`.

### Per-sim options

Within the UI, each tab has two extra knobs:

- **Iterations** — default 10,000 (matches Raidbots free tier). 25,000 matches Raidbots Pro. Higher = lower variance, longer wait.
- **Threads** — leave blank to use all CPU cores. If you want to keep playing while sims run, set this to `cores - 2`.

## Mac / Linux

The launcher is Windows-only, but the server itself is platform-agnostic. On Mac/Linux:

```bash
git clone https://github.com/Gnutmi/LocalSimcraft.git
cd LocalSimcraft
npm install
SIMC_PATH=/usr/local/bin/simc npm start
```

Adjust `SIMC_PATH` to wherever your simc binary lives. On macOS with the official SimulationCraft.app installed, that's typically `/Applications/SimulationCraft.app/Contents/MacOS/simc`.

You may want to write your own shell launcher analogous to `start.cmd` — feel free to PR one.

## Where things live

- `reports/<job-id>/report.html` — the full SimC HTML report (open this for deep theorycraft)
- `reports/<job-id>/input.simc` — the exact `.simc` file fed to simc.exe (handy for debugging or re-running by hand)
- `reports/<job-id>/simc.log` — full simc stdout/stderr
- `jobs/*.json` — job metadata (so the History sidebar survives a restart)

You can safely delete anything in `reports/` and `jobs/` to clean up — they'll be regenerated as you run new sims.

## Architecture

```
browser  ──HTTP──▶  Express  ──spawn──▶  simc.exe
   ▲                   │
   └──── WebSocket ────┘   (live progress + DPS lines)
```

- One sim runs at a time. They're CPU-bound; running two in parallel just halves your iterations/sec without producing results faster.
- The job queue is in-process, with metadata persisted to `jobs/*.json` so the history list survives restarts.
- The frontend is a single-file SPA in `public/index.html`. No build step, no framework — open the file and it works.
- Auto-skip retries failed sims with offending profilesets removed (up to 5 retries), reading SimC's log to identify what to drop.

## Limitations vs Raidbots

- **No curated drop database.** Raidbots maintains drop lists per raid/dungeon. You provide the list of items to test in Droptimizer. ([Adding curated drop lists](#extending) is the obvious next step.)
- **Top Gear is single-swap, not combinatorial.** Raidbots tests combinations of bag items across multiple slots simultaneously; this version tests each bag item as a one-slot swap against your current gear. For most cases (single best-in-slot per piece) this is exactly what you want.
- **No login, no auth, no rate limiting.** This is a LAN tool. Don't expose it to the public internet.
- **Sequential queue only.** Submit one job, it runs. Submit two, they run sequentially. Sims are CPU-bound so this is the right choice anyway.

What's NOT a limitation, contrary to what you might expect:

- ✅ **Wrong armor type items get filtered automatically.** Auto-skip handles plate items in your monk's bag, etc., transparently.
- ✅ **Old items in the bag don't crash sims.** Items SimC's database doesn't know about are skipped, the sim continues.

## Extending

If you want to push it further, the obvious next steps:

- **Curated drop lists per raid.** Drop a JSON file in `data/drops/` keyed by encounter, hook a dropdown into the Droptimizer form, populate the candidates textarea on selection.
- **Stat weights.** SimC has `calculate_scale_factors=1` — wire up a fourth tab.
- **Combinatorial Top Gear.** Generate `Cartesian × slots` profilesets with a sane cap (Raidbots caps at ~1000). The `buildTopGear` function in `lib/profilesets.js` is the place to start.
- **Persistent profiles.** Stash recent profiles in localStorage so you don't have to repaste every time.
- **Mac/Linux launcher.** Write a `start.sh` mirroring `start.cmd`.

PRs welcome.

## License

MIT. See [LICENSE](LICENSE).
