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

// ---------------------------------------------------------------------------
// Auto-skip wrapper
// ---------------------------------------------------------------------------
//
// SimC has an unhelpful failure mode: if any single item in any single
// profileset has a problem its database can't resolve (wrong armor type for
// the class, items added in patches newer than the binary's data, weird bonus
// IDs, retired items, etc.), it aborts the entire sim with exit code 82 and
// you get nothing.
//
// Building a pre-filter would require shipping an item-id-to-armor-type
// database and keeping it in sync with patches — not practical for a small
// project. Instead we let SimC tell us which items it doesn't like, parse
// them out of the profile, and re-run.
//
// The error format we recover from looks like:
//   Error: Profileset 'Parasite Stompers (263)': Player 'Eatship': ...
//
// Anything that doesn't name a profileset (e.g. an error in the baseline
// itself) is unrecoverable and gets surfaced normally.

/**
 * Run a sim, automatically removing profilesets that SimC chokes on and
 * retrying. Same return shape as SimcRunner.run(), plus a `skippedItems`
 * array listing the names that got removed.
 *
 * @param {SimcRunner} runner
 * @param {string} profile
 * @param {object} [opts]                  Forwarded to runner.run.
 * @param {number} [opts.maxRetries=5]     Cap on retry attempts.
 * @returns {Promise<{htmlPath, jsonPath, exitCode, skippedItems: string[]}>}
 */
export async function runWithAutoSkip(runner, profile, opts = {}) {
  const maxRetries = opts.maxRetries ?? 5;
  const skipped = [];
  let currentProfile = profile;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await runner.run(currentProfile, opts);
      return { ...result, skippedItems: skipped };
    } catch (err) {
      // Read the full simc log; we need it to find ALL the bad items in this
      // attempt so a single retry can drop them all in one go (otherwise
      // every bad item costs us an extra pass).
      const logPath = path.join(runner.workDir, 'simc.log');
      let logText = '';
      try { logText = await fs.readFile(logPath, 'utf8'); } catch {}

      const badNames = extractBadProfilesets(logText, currentProfile);

      // No recoverable errors found, OR we've exhausted retries: bubble up.
      if (badNames.length === 0 || attempt === maxRetries) {
        if (skipped.length > 0) {
          // Annotate the error so the user knows we tried.
          err.message = `${err.message}\n(Auto-skip removed ${skipped.length} item(s) earlier in this run; the remaining error wasn't recoverable.)`;
        }
        throw err;
      }

      currentProfile = removeProfilesetsByName(currentProfile, badNames);
      skipped.push(...badNames);

      opts.onProgress?.({
        line: `[auto-skip] Removing ${badNames.length} bad item(s); retrying… (${badNames.join(' | ')})`,
      });
    }
  }
}

/**
 * Find profileset names in SimC's log that we should remove and retry.
 * Uses two passes — strict (no apostrophes) and loose (uses `: Player '` as
 * the right boundary) — and validates each candidate against the profileset
 * names actually defined in the input, so a name with an embedded apostrophe
 * like "Echo of L'ura" still resolves correctly.
 */
function extractBadProfilesets(logText, profile) {
  const definedNames = new Set();
  for (const line of profile.split(/\r?\n/)) {
    const m = line.match(/^profileset\."([^"]+)"\+=/);
    if (m) definedNames.add(m[1]);
  }

  const found = new Set();

  // Pass 1: strict pattern, no apostrophes inside the name.
  const strictRe = /(?:Error|FATAL):?\s*Profileset\s+'([^']+?)':/gi;
  let m;
  while ((m = strictRe.exec(logText)) !== null) {
    if (definedNames.has(m[1])) found.add(m[1]);
  }

  // Pass 2: lazy pattern using ": Player '" as the right boundary, so names
  // containing apostrophes are captured intact. We still validate against
  // definedNames to avoid grabbing garbage.
  const lazyRe = /(?:Error|FATAL):?\s*Profileset\s+'([\s\S]+?)':\s*Player\s+'/gi;
  while ((m = lazyRe.exec(logText)) !== null) {
    if (definedNames.has(m[1])) found.add(m[1]);
  }

  return [...found];
}

/**
 * Strip out any `profileset."NAME"+=...` lines whose names match the given
 * set. Other content is preserved verbatim.
 */
function removeProfilesetsByName(simcText, names) {
  const blocked = new Set(names);
  const out = [];
  for (const line of simcText.split(/\r?\n/)) {
    const m = line.match(/^profileset\."([^"]+)"\+=/);
    if (m && blocked.has(m[1])) continue;
    out.push(line);
  }
  return out.join('\n');
}
