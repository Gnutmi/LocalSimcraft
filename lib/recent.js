// lib/recent.js
// Persists the last few SimC profile pastes per character so the user can
// re-run a sim the next day without re-opening WoW and re-pasting from /simc.
//
// Storage: a single JSON file at data/recent-profiles.json. Structure:
//
//   {
//     "Eatship-Draenor": [
//       { id, profile, savedAt, kind, label },
//       ... up to 3 newest first ...
//     ],
//     "Othername-Realm": [ ... ],
//     ...
//   }
//
// We key by character name + realm because that's what the user thinks in:
// "give me Eatship's last paste". Storing by some surrogate id would be
// surprising when picking from the UI.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PER_CHAR_LIMIT = 3;

// Reasonable size cap so a pathological paste doesn't blow up the file.
// SimC exports are typically 2-4 KB; 64 KB is generous headroom.
const MAX_PROFILE_BYTES = 64 * 1024;

export class RecentProfileStore {
  constructor({ dataDir }) {
    this.file = path.join(dataDir, 'recent-profiles.json');
    this.dataDir = dataDir;
    this.cache = null;
    // Single in-flight write promise so concurrent saves don't clobber each
    // other. The save sequence is: read-modify-write, and we don't want two
    // writers racing on that.
    this.writeChain = Promise.resolve();
  }

  async _load() {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      // Defensive: ignore anything that doesn't look like our shape so a
      // corrupt file doesn't crash the server.
      this.cache = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        ? parsed
        : {};
    } catch {
      // File missing or unreadable — start clean.
      this.cache = {};
    }
    return this.cache;
  }

  async _persist() {
    await fs.mkdir(this.dataDir, { recursive: true });
    const tmp = this.file + '.tmp';
    // Write to a temp file then rename, so a crash mid-write can't leave us
    // with a half-written JSON we then fail to parse on next boot.
    await fs.writeFile(tmp, JSON.stringify(this.cache, null, 2), 'utf8');
    await fs.rename(tmp, this.file);
  }

  /**
   * Public-shaped data for the UI: { character: [ {id, savedAt, label, kind} ] }.
   * NB: we do NOT include the profile text in the listing payload — profiles
   * are large and we only need them when the user actually clicks one. Clients
   * fetch the body on demand via /api/recent/:id.
   */
  async list() {
    const data = await this._load();
    const out = {};
    for (const [character, entries] of Object.entries(data)) {
      out[character] = entries.map((e) => ({
        id: e.id,
        savedAt: e.savedAt,
        label: e.label || null,
        kind: e.kind || null,
        bytes: e.profile?.length ?? 0,
      }));
    }
    return out;
  }

  /**
   * Get a single saved profile (text included).
   */
  async get(id) {
    const data = await this._load();
    for (const entries of Object.values(data)) {
      const hit = entries.find((e) => e.id === id);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * Save a profile under a character key. Inserts at the front of that
   * character's list and trims to PER_CHAR_LIMIT.
   *
   * Dedupe rule: if the *exact* profile text already exists for this
   * character, we move that entry to the front instead of inserting a
   * duplicate. This way "submit the same paste 3 times" doesn't push
   * the user's last meaningfully different paste out.
   *
   * @param {string} character    Display key, e.g. "Eatship-Draenor".
   * @param {string} profile      Full SimC profile text.
   * @param {object} [meta]       { kind: 'quick'|'droptimizer'|'topgear', label: string }
   * @returns {Promise<{id:string}>}
   */
  save(character, profile, meta = {}) {
    if (!character || typeof profile !== 'string' || !profile.trim()) {
      return Promise.resolve(null);
    }
    if (profile.length > MAX_PROFILE_BYTES) {
      // Refuse silently; an oversized paste is almost certainly junk we
      // don't want to keep around. Returning null lets callers move on.
      return Promise.resolve(null);
    }

    // Chain off the previous write so concurrent saves serialize. This
    // matters because saves happen on every job submit and the user might
    // queue several in quick succession.
    this.writeChain = this.writeChain.then(async () => {
      const data = await this._load();
      const list = data[character] ? [...data[character]] : [];

      // Dedupe: if the same profile is already here, drop the old entry
      // first so the new one ends up at the head.
      const dupeIdx = list.findIndex((e) => e.profile === profile);
      let id;
      if (dupeIdx !== -1) {
        id = list[dupeIdx].id;     // preserve id so any UI references stay valid
        list.splice(dupeIdx, 1);
      } else {
        id = crypto.randomBytes(6).toString('hex');
      }

      list.unshift({
        id,
        profile,
        savedAt: Date.now(),
        kind:    meta.kind || null,
        label:   meta.label || null,
      });

      // Trim per-character limit.
      while (list.length > PER_CHAR_LIMIT) list.pop();

      data[character] = list;
      this.cache = data;
      await this._persist();
      return { id };
    }).catch((err) => {
      // Don't let storage problems break sim submission — log and move on.
      console.warn('[recent] save failed:', err.message);
      return null;
    });

    return this.writeChain;
  }

  /**
   * Remove a single saved profile by id. Returns true if it was found.
   */
  remove(id) {
    this.writeChain = this.writeChain.then(async () => {
      const data = await this._load();
      let found = false;
      for (const [character, entries] of Object.entries(data)) {
        const i = entries.findIndex((e) => e.id === id);
        if (i !== -1) {
          entries.splice(i, 1);
          if (entries.length === 0) delete data[character];
          found = true;
          break;
        }
      }
      if (found) {
        this.cache = data;
        await this._persist();
      }
      return found;
    });
    return this.writeChain;
  }
}
