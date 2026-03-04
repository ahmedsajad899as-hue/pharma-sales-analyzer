/**
 * Fuzzy-name matching utilities.
 *
 * Used to detect near-duplicate entity names (drugs, reps, companies, areas)
 * during Excel file uploads, so the same entity is never stored twice with
 * slightly different spellings.
 *
 * Key rules:
 *  1. Names that differ ONLY in numeric suffixes are NOT merged
 *     (e.g. "amoxil 250" ≠ "amoxil 500" — different doses).
 *  2. If one name is a prefix of another AND covers ≥ 55 % of the longer → merge.
 *  3. Levenshtein similarity ≥ 0.85 → merge (covers typos & minor spelling diffs).
 */

// ─── Core edit-distance ───────────────────────────────────────────────────────

/**
 * Compute the Levenshtein edit distance between two strings.
 * Uses a space-optimised two-row DP.
 */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1];
      } else {
        curr[j] = 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
      }
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** Similarity ratio in [0, 1].  1 = identical strings. */
export function similarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

// ─── Normalisation helpers ────────────────────────────────────────────────────

/** Lowercase + trim + collapse whitespace. */
export function normalizeStr(s) {
  return String(s).toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Returns true when the two names have conflicting CORE numbers (i.e. different doses).
 *
 * Logic:
 *  - If either name has NO numbers at all → don't block (e.g. "Conviban tab" vs "CONVIBAN 25MG")
 *  - Extract all digit sequences from each name.
 *  - The shorter number-list is considered the "core" numbers (dose).
 *    If the shorter list is a sequential prefix of the longer → same core, extra
 *    numbers are just pack size (e.g. 500/50 + 60CAP) → don't block.
 *  - Otherwise the core numbers differ → block (e.g. amoxil 250 vs amoxil 500).
 *
 * Examples:
 *   ["500","50"] vs ["500","50","60"] → shorter is prefix of longer → false (don't block)
 *   ["250","50"] vs ["500","50","60"] → 250≠500 → true  (block — different dose)
 *   []           vs ["25","30"]       → one empty  → false (don't block)
 */
function hasDifferentCoreNumbers(a, b) {
  const numsA = (a.match(/\d+/g) || []);
  const numsB = (b.match(/\d+/g) || []);
  if (numsA.length === 0 || numsB.length === 0) return false;
  const shorter = numsA.length <= numsB.length ? numsA : numsB;
  const longer  = numsA.length <= numsB.length ? numsB : numsA;
  // shorter must be a prefix of longer (same order) to be considered "same core"
  return !shorter.every((n, i) => longer[i] === n);
}

/**
 * Word-overlap ratio between two names, ignoring pure numeric tokens and
 * composite dose tokens (e.g. "25mg", "30tab", "60cap", "50mcg").
 *
 * Splits on whitespace and "/" and "-".
 * Keeps only tokens that are longer than 2 chars AND not dose/pack patterns.
 *
 * "conviban tab"      → ["conviban","tab"]
 * "conviban 25mg 30tab" → ["conviban"]          (25mg, 30tab stripped)
 * "airtide 500/50mcg 60cap" → ["airtide"]
 *
 * Returns proportion of shorter-list tokens found in longer list (via substring).
 */
function wordOverlapRatio(a, b) {
  const DOSE_RE = /^\d+(\w{0,4})?$/; // "500", "25mg", "30tab", "60cap", "50mcg" …
  const sig = s =>
    s.split(/[\s\/\-]+/)
     .filter(w => w.length > 2 && !DOSE_RE.test(w));
  const wa = sig(a), wb = sig(b);
  if (wa.length === 0 || wb.length === 0) return 0;
  const shorter = wa.length <= wb.length ? wa : wb;
  const longer  = wa.length <= wb.length ? wb : wa;
  const matched = shorter.filter(w => longer.some(lw => lw.includes(w) || w.includes(lw)));
  return matched.length / shorter.length;
}

// ─── Similarity decision ─────────────────────────────────────────────────────

/**
 * Decides whether two names should be merged.
 *
 * @param {string} nameA
 * @param {string} nameB
 * @param {{ lev?: number, prefixRatio?: number, wordOverlap?: number }} opts
 * @returns {boolean}
 */
export function areSimilar(nameA, nameB, { lev = 0.85, prefixRatio = 0.55, wordOverlap = 0.8 } = {}) {
  const a = normalizeStr(nameA);
  const b = normalizeStr(nameB);

  if (a === b) return false; // identical → already same DB record, nothing to flag

  // Block if core dose-numbers conflict (e.g. amoxil 250 vs amoxil 500)
  if (hasDifferentCoreNumbers(a, b)) return false;

  // ── Prefix rule ──────────────────────────────────────────────────────────
  const shorter = a.length <= b.length ? a : b;
  const longer  = a.length <= b.length ? b : a;
  if (longer.startsWith(shorter) && shorter.length / longer.length >= prefixRatio) {
    return true;
  }

  // ── Levenshtein rule ────────────────────────────────────────────────────
  if (similarity(a, b) >= lev) return true;

  // ── Word-overlap rule ───────────────────────────────────────────────────
  // Catches: "Conviban tab" ↔ "CONVIBAN 25MG 30TAB"
  //          "AIRTIDE 500 mcg/50 mcg" ↔ "AIRTIDE 500/50MCG 60CAP"
  if (wordOverlapRatio(a, b) >= wordOverlap) return true;

  return false;
}

// ─── Canonical lookup ─────────────────────────────────────────────────────────

/**
 * Given a new name and an ordered list of canonical names, return the first
 * canonical name that is considered similar, or null if no match found.
 *
 * @param {string}   newName
 * @param {string[]} canonicalNames – already-accepted names (DB or current file)
 * @returns {string|null}
 */
export function findCanonical(newName, canonicalNames) {
  for (const canonical of canonicalNames) {
    if (areSimilar(newName, canonical)) return canonical;
  }
  return null;
}

// ─── Batch normalisation ─────────────────────────────────────────────────────

/**
 * Build a normalisation map for a list of entity names.
 *
 * For each name that fuzzy-matches an *existing* DB name or an already-accepted
 * name from the SAME batch, the map entry `{ from, to, source }` is added.
 *
 * Names that pass as "new canonical" are added to `accepted` so subsequent
 * names in the same batch are also deduplicated against them.
 *
 * @param {string[]} incomingNames  – unique names from the newly uploaded file
 * @param {string[]} existingNames  – names already in the DB for this user
 * @param {string}   entityType     – 'item' | 'rep' | 'company' | 'area'  (for labelling)
 * @returns {{ map: Record<string,string>, log: Array<{from,to,source,entityType}> }}
 */
export function buildNormalizationMap(incomingNames, existingNames, entityType = 'item') {
  const map = {};   // { incomingName → canonicalName }
  const log = [];   // human-readable log entries

  // "accepted" starts with all existing names; new canonical names are appended
  const accepted = [...existingNames];

  for (const name of incomingNames) {
    if (!name || name === 'غير محدد') {
      accepted.push(name); // keep as-is
      continue;
    }

    const canonical = findCanonical(name, accepted);
    if (canonical && canonical !== name) {
      // Found a near-duplicate → normalise to canonical
      map[name] = canonical;
      const source = existingNames.includes(canonical) ? 'db' : 'file';
      log.push({ from: name, to: canonical, source, entityType });
    } else {
      // No match → this name becomes the new canonical for subsequent names
      accepted.push(name);
    }
  }

  return { map, log };
}
