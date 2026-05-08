// lib/simc.js
// Thin wrapper around the simc.exe CLI: writes a profile to disk, spawns the
// process, streams progress lines back to the caller, and resolves with paths
// to the generated HTML/JSON reports.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// SimC's progress output looks like:  "  10% [...]   1500 DPS"
// We pull out the leading percentage so the UI can show a progress bar.
const PROGRESS_RE = /^\s*(\d{1,3})%/;

// DPS summary lines for profilesets in stdout look like:
//   "  Player Name              :    1234567.89 dps"
// We surface a few of these for live feedback while the run is in flight.
const DPS_LINE_RE = /^\s+(.+?)\s*:\s+([\d,.]+)\s+dps/;

export class SimcRunner {
  /**
   * @param {object} opts
   * @param {string} opts.simcPath  Absolute path to simc.exe (or the binary on
   *                                non-Windows). Configured via SIMC_PATH env.
   * @param {string} opts.workDir   Per-job working directory; the profile and
   *                                report files all land here.
   */
  constructor({ simcPath, workDir }) {
    this.simcPath = simcPath;
    this.workDir = workDir;
    this.proc = null;
  }

  async ensureWorkDir() {
    await fs.mkdir(this.workDir, { recursive: true });
  }

  /**
   * Run a sim against a given .simc profile string.
   *
   * @param {string} profile        Full SimC profile text (base + profilesets).
   * @param {object} opts
   * @param {number} [opts.iterations]  Override iteration count.
   * @param {number} [opts.threads]     Worker threads (defaults to CPU count).
   * @param {(p:{percent?:number, line:string})=>void} [opts.onProgress]
   * @returns {Promise<{htmlPath:string, jsonPath:string, exitCode:number}>}
   */
  async run(profile, opts = {}) {
    await this.ensureWorkDir();

    const profilePath = path.join(this.workDir, 'input.simc');
    const htmlPath    = path.join(this.workDir, 'report.html');
    const jsonPath    = path.join(this.workDir, 'report.json');
    const logPath     = path.join(this.workDir, 'simc.log');

    await fs.writeFile(profilePath, profile, 'utf8');

    // SimC reads command-line args left-to-right and applies them as overrides
    // on top of whatever's in the profile, so we put output flags AFTER the
    // input file. `json2=` produces the structured JSON the UI parses for the
    // results table; `html=` is the rich human-facing report.
    const args = [
      profilePath,
      `html=${htmlPath}`,
      `json2=${jsonPath}`,
    ];
    if (opts.iterations) args.push(`iterations=${opts.iterations}`);
    if (opts.threads)    args.push(`threads=${opts.threads}`);

    return new Promise((resolve, reject) => {
      const logStream = [];
      const proc = spawn(this.simcPath, args, {
        cwd: this.workDir,
        windowsHide: true,
      });
      this.proc = proc;

      let buffer = '';
      const handleChunk = (chunk) => {
        buffer += chunk.toString('utf8');
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).replace(/\r$/, '');
          buffer = buffer.slice(nl + 1);
          logStream.push(line);

          if (!opts.onProgress) continue;
          const pm = line.match(PROGRESS_RE);
          if (pm) {
            opts.onProgress({ percent: Number(pm[1]), line });
            continue;
          }
          // Forward DPS summary lines and "Generating..." status messages so
          // the UI can stream them into the live log panel.
          if (DPS_LINE_RE.test(line) || /^Generating|^Reports generated/.test(line)) {
            opts.onProgress({ line });
          }
        }
      };

      proc.stdout.on('data', handleChunk);
      proc.stderr.on('data', handleChunk);

      proc.on('error', (err) => {
        // Most common failure mode: SIMC_PATH points nowhere. Wrap with a
        // friendlier message before bubbling up.
        reject(new Error(
          `Could not start simc at "${this.simcPath}". ` +
          `Check SIMC_PATH in .env. Underlying error: ${err.message}`
        ));
      });

      proc.on('close', async (exitCode) => {
        await fs.writeFile(logPath, logStream.join('\n'), 'utf8').catch(() => {});
        if (exitCode !== 0) {
          reject(new Error(
            `simc exited with code ${exitCode}. See ${logPath} for full output. ` +
            `Last line: ${logStream.slice(-1)[0] ?? '(empty)'}`
          ));
          return;
        }
        resolve({ htmlPath, jsonPath, exitCode });
      });
    });
  }

  cancel() {
    if (this.proc && !this.proc.killed) {
      this.proc.kill();
    }
  }
}

/**
 * Read the JSON report SimC writes alongside the HTML and pull out the data
 * the UI actually cares about: per-profileset DPS plus the baseline.
 */
export async function parseJsonReport(jsonPath) {
  const raw = await fs.readFile(jsonPath, 'utf8');
  const data = JSON.parse(raw);

  const sim = data.sim ?? data;
  const players = sim.players ?? [];

  // The "baseline" run is always the first player in the report; profilesets
  // appear in sim.profilesets.results. SimC normalises names there.
  const baseline = players[0]
    ? {
        name: players[0].name,
        dps: players[0].collected_data?.dps?.mean ?? null,
        dpsErr: players[0].collected_data?.dps?.mean_std_dev ?? null,
      }
    : null;

  const profilesets = sim.profilesets?.results ?? [];
  const results = profilesets.map((p) => ({
    name: p.name,
    dps: p.mean ?? null,
    dpsMin: p.min ?? null,
    dpsMax: p.max ?? null,
    stddev: p.stddev ?? null,
  }));

  // Sort highest DPS first so the UI can show a ranked table without extra work.
  results.sort((a, b) => (b.dps ?? -Infinity) - (a.dps ?? -Infinity));

  return { baseline, results, raw: data };
}
