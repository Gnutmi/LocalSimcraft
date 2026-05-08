// server.js
// Local Raidbots-style web UI for SimulationCraft.
//
// Single-process Node server that:
//   - serves the static SPA in public/
//   - accepts sim job submissions (quick / droptimizer / topgear)
//   - runs them one at a time through a queue (sims are CPU-bound, parallelism
//     would just thrash and confuse the live progress UI)
//   - streams progress + DPS lines to connected browsers over a WebSocket
//   - exposes the SimC HTML reports as static files
//
// Designed for LAN use only. There's no auth — don't expose this to the
// public internet.

import express from 'express';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { WebSocketServer } from 'ws';

import { SimcRunner, runWithAutoSkip, parseJsonReport } from './lib/simc.js';
import { JobQueue } from './lib/queue.js';
import {
  buildQuickSim, buildDroptimizer, buildTopGear,
} from './lib/profilesets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ---------- config ---------------------------------------------------------

// SIMC_PATH: absolute path to simc.exe (Windows) or simc binary (Mac/Linux).
// PORT:     listening port; defaults to 3737.
// HOST:     bind address; default 0.0.0.0 so the LAN can reach it.
const PORT      = Number(process.env.PORT || 3737);
const HOST      = process.env.HOST || '0.0.0.0';
const SIMC_PATH = process.env.SIMC_PATH || guessSimcPath();

const REPORTS_DIR = path.join(__dirname, 'reports');
const JOBS_DIR    = path.join(__dirname, 'jobs');
const PUBLIC_DIR  = path.join(__dirname, 'public');
const DATA_DIR    = path.join(__dirname, 'data');

function guessSimcPath() {
  // Reasonable defaults for the most common installs. The user can override
  // via .env or by setting SIMC_PATH before launching.
  if (process.platform === 'win32') {
    return 'C:\\SimulationCraft\\simc.exe';
  }
  if (process.platform === 'darwin') {
    return '/Applications/SimulationCraft.app/Contents/MacOS/simc';
  }
  return '/usr/local/bin/simc';
}

async function checkSimc() {
  try {
    await fs.access(SIMC_PATH);
    return true;
  } catch {
    console.warn(
      `\n  ⚠  SimC binary not found at: ${SIMC_PATH}\n` +
      `     Set SIMC_PATH to point at your simc.exe before submitting jobs.\n`
    );
    return false;
  }
}

// ---------- runner used by the queue ---------------------------------------

async function runJob(job, update) {
  const runner = new SimcRunner({
    simcPath: SIMC_PATH,
    workDir: job.reportDir,
  });

  // Persist the SimC input we built so the user can inspect/re-run it.
  await fs.mkdir(job.reportDir, { recursive: true });
  await fs.writeFile(path.join(job.reportDir, 'input.simc'), job.simcInput, 'utf8');

  update({ logLine: `[${new Date().toISOString()}] Starting ${job.kind} sim…` });
  update({ logLine: `simc: ${SIMC_PATH}` });

  const { jsonPath, skippedItems } = await runWithAutoSkip(runner, job.simcInput, {
    iterations: job.options.iterations,
    threads:    job.options.threads,
    maxRetries: 5,
    onProgress: ({ percent, line }) => {
      const patch = { logLine: line };
      if (typeof percent === 'number') patch.progress = percent;
      update(patch);
    },
  });

  // Surface skipped items prominently in the log so the user can see what
  // didn't get tested. Common reasons: wrong armor type for the class, items
  // newer than the simc binary's data files, items with bonus IDs simc
  // can't resolve.
  if (skippedItems && skippedItems.length > 0) {
    update({
      logLine:
        `[auto-skip] Final tally: ${skippedItems.length} item(s) excluded — ` +
        skippedItems.map((n) => `"${n}"`).join(', ') +
        `. Update simc.exe (https://www.simulationcraft.org/download.html) ` +
        `if you expected these to work.`,
    });
  }

  // Parse the JSON report into a results table the UI can render directly,
  // so we don't have to re-parse on every page load.
  try {
    const parsed = await parseJsonReport(jsonPath);
    update({
      results: { baseline: parsed.baseline, profilesets: parsed.results },
      logLine: `Parsed ${parsed.results.length} profileset result(s).`,
    });
  } catch (err) {
    // Quick sims have no profilesets, so a failure to parse those isn't fatal.
    update({ logLine: `Note: could not parse profilesets (${err.message}).` });
  }
}

// ---------- queue + server bootstrap ---------------------------------------

const queue = new JobQueue({
  jobsDir: JOBS_DIR,
  reportsDir: REPORTS_DIR,
  runner: runJob,
});
await queue.init();

const app = express();
app.use(express.json({ limit: '4mb' })); // SimC profiles are small; bag exports can grow

// ---- API: status / config -------------------------------------------------

app.get('/api/status', async (_req, res) => {
  const simcOk = await checkSimc();
  res.json({
    ok: true,
    simcPath: SIMC_PATH,
    simcOk,
    cpus: os.cpus().length,
    platform: process.platform,
  });
});

// ---- API: jobs ------------------------------------------------------------

app.get('/api/jobs', (_req, res) => {
  res.json(queue.list());
});

app.get('/api/jobs/:id', (req, res) => {
  const j = queue.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'job not found' });
  res.json(j);
});

// Submit a Quick Sim. Body: { profile, iterations?, threads? }
app.post('/api/sim/quick', async (req, res) => {
  try {
    const { profile, iterations, threads } = req.body || {};
    if (!profile || typeof profile !== 'string') {
      return res.status(400).json({ error: 'profile (SimC string) is required' });
    }
    const id = await queue.submit({
      kind: 'quick',
      label: extractCharLabel(profile) || 'Quick Sim',
      simc: buildQuickSim(profile),
      options: { iterations, threads },
    });
    res.json({ id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Submit a Droptimizer. Body: { profile, candidates: string[], iterations?, threads? }
// `candidates` is a list of SimC gear-format lines, one per item to test.
app.post('/api/sim/droptimizer', async (req, res) => {
  try {
    const { profile, candidates, iterations, threads } = req.body || {};
    if (!profile)   return res.status(400).json({ error: 'profile is required' });
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return res.status(400).json({ error: 'candidates[] must be a non-empty array of SimC gear lines' });
    }
    const simc = buildDroptimizer(profile, candidates);
    const id = await queue.submit({
      kind: 'droptimizer',
      label: `${extractCharLabel(profile) || 'Droptimizer'} · ${candidates.length} items`,
      simc,
      options: { iterations, threads },
    });
    res.json({ id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Submit a Top Gear. Body: { profile, iterations?, threads? }
// Bag items are expected to be present as commented gear lines in the profile
// (this is what the in-game SimC addon emits when you tick "Show Bag Items").
app.post('/api/sim/topgear', async (req, res) => {
  try {
    const { profile, iterations, threads } = req.body || {};
    if (!profile) return res.status(400).json({ error: 'profile is required' });
    const { simc, count, skipped } = buildTopGear(profile);
    if (count === 0) {
      return res.status(400).json({
        error: 'no bag items detected. Make sure the SimC addon export includes bag contents (the addon has a checkbox for this).',
      });
    }
    const id = await queue.submit({
      kind: 'topgear',
      label: `${extractCharLabel(profile) || 'Top Gear'} · ${count} swaps${skipped ? ` (${skipped} skipped)` : ''}`,
      simc,
      options: { iterations, threads },
    });
    res.json({ id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- static files ---------------------------------------------------------

app.use('/', express.static(PUBLIC_DIR));

// Serve report HTMLs and other artifacts. We restrict this to a single
// directory tree and resolve through path.join so users can't ../ their way
// out of it.
app.get('/reports/:id/:file', async (req, res) => {
  const safeFile = path.basename(req.params.file);
  const safeId   = path.basename(req.params.id);
  const target = path.join(REPORTS_DIR, safeId, safeFile);
  try {
    await fs.access(target);
    res.sendFile(target);
  } catch {
    res.status(404).send('not found');
  }
});

// Sample data (for UI hints / starter item lists).
app.use('/data', express.static(DATA_DIR));

// ---- WebSocket: live job updates -----------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  // Send the full current job list on connect so the UI has something to
  // render immediately without a separate fetch.
  ws.send(JSON.stringify({ type: 'snapshot', jobs: queue.list() }));

  const onUpdate = (job) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: 'update', job }));
  };
  queue.on('update', onUpdate);

  ws.on('close', () => queue.off('update', onUpdate));
});

// ---------- helpers --------------------------------------------------------

/**
 * Pull "Charname-Realm" from a SimC profile. The first line of an addon
 * export is always something like  warrior="Uwantmace"  followed later by
 * server="EU-Twisting Nether". We use this for the UI's job label.
 */
function extractCharLabel(profile) {
  const nameM = profile.match(/^(?:death_knight|demon_hunter|druid|evoker|hunter|mage|monk|paladin|priest|rogue|shaman|warlock|warrior)\s*=\s*"([^"]+)"/mi);
  const realmM = profile.match(/^server\s*=\s*"?([^"\n]+)"?/m);
  if (nameM && realmM)  return `${nameM[1]}-${realmM[1].trim()}`;
  if (nameM)            return nameM[1];
  return null;
}

// ---------- start ----------------------------------------------------------

await checkSimc(); // warn at startup, but don't block — user can fix later

server.listen(PORT, HOST, () => {
  const niceHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`\n  simlocal listening on http://${niceHost}:${PORT}\n`);
  console.log(`  SimC: ${SIMC_PATH}`);
  console.log(`  CPUs: ${os.cpus().length}\n`);
});
