// lib/itemfilter.js
//
// Heuristic filtering for bag items before they get fed to SimC. Solves two
// problems the auto-skip retry mechanism can't:
//
//   1. SimC happily sims items the player can't actually equip (e.g. an
//      Intellect off-hand on a melee character — it just stat-converts and
//      reports a meaningless DPS number). Auto-skip can't catch this because
//      SimC doesn't error.
//
//   2. SimC has no concept of "weapon configuration legality" — it'll let
//      you swap an off-hand onto a character wielding a 2H weapon, which is
//      illegal in-game but produces a fake DPS gain.
//
// We work from item NAMES (which the addon export gives us) plus the
// character's class+spec to make these decisions. It's heuristic, not perfect
// — the bias is "only skip items we're confident are wrong; leave ambiguous
// ones alone so the player sees them and can judge".

// ---------------------------------------------------------------------------
// Class + spec → primary stat
// ---------------------------------------------------------------------------

// Most classes have one stat across all specs.
const CLASS_DEFAULT_STAT = {
  death_knight: 'strength',
  warrior:      'strength',
  demon_hunter: 'agility',
  hunter:       'agility',
  rogue:        'agility',
  mage:         'intellect',
  warlock:      'intellect',
  priest:       'intellect',
  evoker:       'intellect',
};

// The mixed classes need spec disambiguation.
const MIXED_CLASS_STATS = {
  druid:   { balance: 'intellect', restoration: 'intellect',
             feral:   'agility',   guardian:    'agility'   },
  monk:    { mistweaver: 'intellect',
             windwalker: 'agility', brewmaster: 'agility'   },
  paladin: { holy: 'intellect',
             protection: 'strength', retribution: 'strength' },
  shaman:  { elemental: 'intellect', restoration: 'intellect',
             enhancement: 'agility'                         },
};

/**
 * Determine the player's primary stat from the SimC profile.
 * Returns 'agility' | 'strength' | 'intellect' | null (unknown).
 */
export function detectPrimaryStat(profile) {
  const classMatch = profile.match(
    /^(death_knight|demon_hunter|druid|evoker|hunter|mage|monk|paladin|priest|rogue|shaman|warlock|warrior)\s*=\s*"/m
  );
  const cls = classMatch?.[1];
  if (!cls) return null;

  if (CLASS_DEFAULT_STAT[cls]) return CLASS_DEFAULT_STAT[cls];

  const specMatch = profile.match(/^spec\s*=\s*(\w+)/m);
  const spec = specMatch?.[1]?.toLowerCase();
  if (!spec) return null;

  return MIXED_CLASS_STATS[cls]?.[spec] ?? null;
}

// ---------------------------------------------------------------------------
// Item name heuristics
// ---------------------------------------------------------------------------

// Off-hand items whose names mark them as caster-only. Things actual melees
// would never wield.
const CASTER_OH_PATTERNS = [
  /\brod\b/i, /\btome\b/i, /\bgrimoire\b/i, /\bcodex\b/i,
  /\borb\b/i, /\bsphere\b/i, /\blantern\b/i, /\bidol\b/i,
];

// Main-hand caster weapons. "Cane" and "Wand" are the unambiguous ones.
// "Staff" is intentionally NOT here — Brewmaster/WW Monk and Druid Feral can
// use staves, so flagging staff-named items as caster would produce false
// positives.
const CASTER_MH_PATTERNS = [
  /\bcane\b/i, /\bwand\b/i, /\bscepter\b/i,
];

// Two-handed melee weapons (strength or agility). The "Great-" prefix and
// names like "Spear", "Polearm" are reliable 2H markers.
const MELEE_2H_PATTERNS = [
  /\bspear\b/i, /\bpolearm\b/i,
  /\bgreat\s*sword\b/i, /\bgreat\s*axe\b/i, /\bgreat\s*mace\b/i,
  /\bmaul\b/i, /\btwo[-\s]?hand/i,
  /\bglaive\b/i,        // warglaives (DH) are 1H actually, but lone "glaive" usually 2H
  /\bbow\b/i, /\bcrossbow\b/i, /\brifle\b/i, /\bgun\b/i,
];

// Caster 2H weapons (Intellect).
const CASTER_2H_PATTERNS = [
  /\bstave\b/i,
  // "staff" is too ambiguous — monks/druids use them — so leave out.
];

/**
 * Classify a weapon-slot bag item by name.
 *
 * @param {string} label  Item name from the addon export (e.g. "Vexamus' Expulsion Rod (289)").
 * @param {'main_hand'|'off_hand'} slot
 * @returns {{ type: '1h'|'2h'|'oh'|'unknown', stat: 'physical'|'intellect'|'unknown' }}
 */
export function classifyWeapon(label, slot) {
  if (!label) return { type: 'unknown', stat: 'unknown' };
  const name = String(label);

  if (slot === 'off_hand') {
    if (CASTER_OH_PATTERNS.some((re) => re.test(name))) {
      return { type: 'oh', stat: 'intellect' };
    }
    // Generic off-hand (1H weapon used in OH slot, or shield, or other).
    return { type: 'oh', stat: 'unknown' };
  }

  if (slot === 'main_hand') {
    if (CASTER_MH_PATTERNS.some((re) => re.test(name))) {
      return { type: '1h', stat: 'intellect' };
    }
    if (CASTER_2H_PATTERNS.some((re) => re.test(name))) {
      return { type: '2h', stat: 'intellect' };
    }
    if (MELEE_2H_PATTERNS.some((re) => re.test(name))) {
      return { type: '2h', stat: 'physical' };
    }
    // Unknown: could be a 1H sword, axe, dagger, mace, fist weapon. Default
    // to 1H since most named weapons that don't match the 2H patterns are 1H.
    // The "stat" is unknown — could be Str or Agi depending on item, but
    // not Int (Int weapons usually have caster names that we've matched above).
    return { type: '1h', stat: 'unknown' };
  }

  return { type: 'unknown', stat: 'unknown' };
}

// ---------------------------------------------------------------------------
// Equipped weapon configuration
// ---------------------------------------------------------------------------

/**
 * Look at the equipped weapons in a profile to figure out whether the
 * character is using a 2H weapon, dual-wielding 1H+OH, or something else.
 *
 * Returns { kind: '2h' | 'dual' | 'mh_only' | 'none', mainName, offName }
 *
 * "mh_only" is a fallback for "main_hand is set, off_hand isn't, and we
 * can't tell from the main-hand name whether it's a 2H". Most likely 2H but
 * we don't want to assume — combo logic skips this case.
 */
export function detectEquippedWeaponConfig(profile) {
  const lines = profile.split(/\r?\n/);
  let mainName = null, offName = null;
  let mhSet = false, ohSet = false;

  let prevComment = null;
  for (const line of lines) {
    const cm = line.match(/^#\s+(\S.*?)\s*$/);
    if (cm) { prevComment = cm[1]; continue; }
    if (/^\s*#\s*$/.test(line)) continue; // empty comment, preserve prevComment

    if (/^main_hand\s*=/.test(line)) { mhSet = true; mainName = prevComment; }
    else if (/^off_hand\s*=/.test(line)) { ohSet = true; offName = prevComment; }

    // Any non-comment line resets prevComment so we don't grab stale labels.
    if (!line.trim().startsWith('#')) prevComment = null;
  }

  if (mhSet && ohSet) return { kind: 'dual', mainName, offName };
  if (mhSet && !ohSet) {
    // No off-hand equipped almost always means a 2H weapon. We try to
    // confirm via the main-hand item name (so we can show it nicely in the
    // UI), but for filter logic we treat it as 2H regardless — the name
    // heuristic is too unreliable to flip behaviour off of.
    const cls = mainName ? classifyWeapon(mainName, 'main_hand') : null;
    return {
      kind: '2h',
      confirmed: cls?.type === '2h',  // true if we're sure from the name
      mainName,
    };
  }
  return { kind: 'none' };
}

// ---------------------------------------------------------------------------
// Bag item filtering
// ---------------------------------------------------------------------------

/**
 * Filter a list of bag-item candidates against the player's spec/weapon
 * config. Returns:
 *   accepted:    [{ slotLine, label, extras? }]   — sim these
 *   skipped:     [{ label, slot, reason }]        — skipped, with explanation
 *   combos:      [{ mhCand, ohCand, label }]      — combinatorial 1H+OH swaps
 *
 * Non-weapon slots (head/chest/etc.) pass through untouched — armor type
 * mismatches are handled by the auto-skip-on-error mechanism in simc.js,
 * since SimC errors loudly on those.
 *
 * @param {string} profile     The clean base profile.
 * @param {Array<{slotLine:string,label:string|null}>} candidates
 * @param {(line:string) => string|null} detectSlotFn  Inject the existing
 *                                                    detectSlot helper.
 */
export function filterBagItems(profile, candidates, detectSlotFn) {
  const stat   = detectPrimaryStat(profile);
  const wpncfg = detectEquippedWeaponConfig(profile);

  const accepted = [];
  const skipped  = [];

  // Track weapon candidates separately so we can build combos at the end.
  const bag1HMains = [];
  const bag2HMains = [];
  const bagOffhands = [];

  for (const cand of candidates) {
    const slot = detectSlotFn(cand.slotLine);
    if (!slot) {
      skipped.push({ label: cand.label, slot: '?', reason: 'unrecognized slot' });
      continue;
    }

    // Non-weapon slots: armor type mismatches show up as SimC errors and get
    // handled by auto-skip retry. We accept them all here.
    if (slot !== 'main_hand' && slot !== 'off_hand') {
      accepted.push(cand);
      continue;
    }

    const wcls = classifyWeapon(cand.label, slot);

    // 1) Stat sanity: melee shouldn't sim Intellect weapons, casters
    //    shouldn't sim physical weapons. We only skip when we're confident.
    if (wcls.stat === 'intellect' && (stat === 'agility' || stat === 'strength')) {
      skipped.push({
        label: cand.label, slot,
        reason: `Intellect weapon for ${stat[0].toUpperCase() + stat.slice(1)} spec`
      });
      continue;
    }
    if (wcls.stat === 'physical' && stat === 'intellect') {
      skipped.push({
        label: cand.label, slot,
        reason: `Physical weapon for Intellect caster spec`
      });
      continue;
    }

    // 2) Weapon-config legality.
    if (slot === 'off_hand') {
      if (wpncfg.kind === '2h') {
        // Off-hand alone with a 2H equipped → illegal unless paired with
        // a 1H bag main-hand. Set aside for combo expansion.
        bagOffhands.push(cand);
        // Fall through to skip the standalone profileset; combo handling
        // below will surface valid pairings.
        skipped.push({
          label: cand.label, slot,
          reason: `Off-hand can't pair with equipped 2H alone (will be tested in combos if a 1H bag main-hand exists)`
        });
        continue;
      }
      // Dual-wield equipped: swapping off-hand alone is fine.
      accepted.push(cand);
      continue;
    }

    // slot === 'main_hand'
    if (wcls.type === '2h') {
      // 2H bag item.
      if (wpncfg.kind === 'dual') {
        // Replacing 1H+OH with a 2H means we also need to clear the off-hand.
        accepted.push({
          ...cand,
          extras: { off_hand: 'CLEAR' },
          comboNote: '2H replaces dual-wield (off-hand cleared)',
        });
      } else {
        accepted.push(cand);
      }
      bag2HMains.push(cand);
      continue;
    }

    if (wcls.type === '1h') {
      if (wpncfg.kind === '2h') {
        // 1H alone with 2H equipped → illegal. Defer for combo.
        bag1HMains.push(cand);
        skipped.push({
          label: cand.label, slot,
          reason: `1H weapon needs off-hand (currently 2H equipped; will be tested in combos if a bag off-hand exists)`
        });
        continue;
      }
      accepted.push(cand);
      continue;
    }

    // Unknown type, just pass through.
    accepted.push(cand);
  }

  // 3) Combinatorial weapon swaps for the 2H-equipped case. For each (MH,
  //    OH) pair from the bags, generate a "swap both" profileset.
  const combos = [];
  if (wpncfg.kind === '2h' && bag1HMains.length > 0 && bagOffhands.length > 0) {
    for (const mh of bag1HMains) {
      const mhCls = classifyWeapon(mh.label, 'main_hand');
      // Don't combine caster main-hands with melee specs even if our earlier
      // pass missed them. (Belt-and-braces.)
      if (mhCls.stat === 'intellect' && (stat === 'agility' || stat === 'strength')) continue;

      for (const oh of bagOffhands) {
        const ohCls = classifyWeapon(oh.label, 'off_hand');
        if (ohCls.stat === 'intellect' && (stat === 'agility' || stat === 'strength')) continue;
        if (ohCls.stat === 'physical' && stat === 'intellect') continue;

        combos.push({
          mhCand: mh,
          ohCand: oh,
          label: `${mh.label || 'MH'} + ${oh.label || 'OH'}`.slice(0, 80),
        });
      }
    }
  }

  return { accepted, skipped, combos, primaryStat: stat, weaponConfig: wpncfg };
}
