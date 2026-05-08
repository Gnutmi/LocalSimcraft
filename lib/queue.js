// lib/queue.js
// A tiny in-memory job queue with disk-backed metadata. We deliberately don't
// use a real queue library — a single Node process running one simc.exe at a
// time is exactly what we want, and persistence is just so jobs survive a
// server restart so the user can still find their reports.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

export class JobQueue extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.jobsDir   Where job metadata JSON files live.
   * @param {string} opts.reportsDir Per-job working/output directory parent.
   * @param {(job:Job)=>Promise<void>} opts.runner  Worker function for one job.
   */
  constructor({ jobsDir, reportsDir, runner }) {
    super();
    this.jobsDir = jobsDir;
    this.reportsDir = reportsDir;
    this.runner = runner;
    this.queue = [];
    this.current = null;
    this.jobs = new Map(); // id -> Job snapshot
  }

  async init() {
    await fs.mkdir(this.jobsDir, { recursive: true });
    await fs.mkdir(this.reportsDir, { recursive: true });

    // Load any persisted jobs so the UI's history list survives a restart.
    // Anything that was "running" when the server died is marked as
    // interrupted — we don't try to resume mid-sim.
    const files = await fs.readdir(this.jobsDir).catch(() => []);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const data = JSON.parse(await fs.readFile(path.join(this.jobsDir, f), 'utf8'));
        if (data.status === 'running' || data.status === 'queued') {
          data.status = 'interrupted';
          data.error = data.error || 'Server restarted while job was running.';
        }
        this.jobs.set(data.id, data);
      } catch {
        // Corrupt job file — leave it alone, ignore.
      }
    }
  }

  /**
   * Enqueue a new job.
   *
   * @param {object} spec
   * @param {'quick'|'droptimizer'|'topgear'} spec.kind
   * @param {string} spec.label    Human-friendly label for the UI.
   * @param {string} spec.simc     Final SimC input string.
   * @param {object} [spec.options] Iterations/threads/etc. forwarded to runner.
   * @returns {Promise<string>} job id
   */
  async submit(spec) {
    const id = crypto.randomBytes(6).toString('hex');
    const job = {
      id,
      kind: spec.kind,
      label: spec.label,
      status: 'queued',
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      progress: 0,
      log: [],
      simcInput: spec.simc,
      options: spec.options || {},
      reportDir: path.join(this.reportsDir, id),
      error: null,
      results: null,
    };
    this.jobs.set(id, job);
    await this._persist(job);
    this.queue.push(id);
    this.emit('update', this._public(job));
    this._tick();
    return id;
  }

  list() {
    // Newest first. The UI renders this as the history sidebar.
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((j) => this._public(j));
  }

  get(id) {
    const j = this.jobs.get(id);
    return j ? this._public(j) : null;
  }

  /** Public-facing snapshot; we trim simcInput to keep API responses small. */
  _public(j) {
    return {
      id: j.id,
      kind: j.kind,
      label: j.label,
      status: j.status,
      createdAt: j.createdAt,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      progress: j.progress,
      log: j.log.slice(-200), // cap log size in API responses
      options: j.options,
      error: j.error,
      results: j.results,
      hasReport: j.status === 'done',
    };
  }

  async _persist(job) {
    const file = path.join(this.jobsDir, `${job.id}.json`);
    // We persist a slim copy — the SimC input lives in input.simc inside the
    // report dir, so we don't need to duplicate it in the job metadata.
    const slim = { ...job, simcInput: undefined };
    await fs.writeFile(file, JSON.stringify(slim, null, 2), 'utf8');
  }

  _tick() {
    if (this.current) return;          // already busy
    const next = this.queue.shift();
    if (!next) return;
    const job = this.jobs.get(next);
    if (!job) return this._tick();     // skip ghost
    this.current = job;
    this._run(job).finally(() => {
      this.current = null;
      this._tick();
    });
  }

  async _run(job) {
    job.status = 'running';
    job.startedAt = Date.now();
    this.emit('update', this._public(job));
    await this._persist(job);

    try {
      await this.runner(job, (patch) => {
        // Progress callback the runner uses to update DPS / percent / log.
        Object.assign(job, patch);
        if (patch.logLine) {
          job.log.push(patch.logLine);
          if (job.log.length > 5000) job.log.splice(0, job.log.length - 5000);
        }
        this.emit('update', this._public(job));
      });
      job.status = 'done';
      job.progress = 100;
    } catch (err) {
      job.status = 'error';
      job.error = err.message || String(err);
    } finally {
      job.finishedAt = Date.now();
      this.emit('update', this._public(job));
      await this._persist(job);
    }
  }
}
