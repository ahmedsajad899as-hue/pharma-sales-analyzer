/**
 * Item-name fuzzy matching for the frontend — a faithful TS port of the safe
 * rules in server/lib/fuzzyMatch.js (areSimilar). Used to match a manager's
 * target item to the uploaded sales' item even when the two are stored under
 * slightly different spellings (e.g. "AIRTIDE 100 mcg/50 mcg" vs
 * "AIRTIDE 100 mcg 50 mcg", "PANTACTIVE 40MG 28TAB" vs "Pantactive 40 mg").
 *
 * Key safety rule preserved from the backend: names that differ in their CORE
 * dose numbers are NEVER matched (100 ≠ 500), so different strengths of the
 * same brand are kept apart.
 */

// ─── Normalisation ────────────────────────────────────────────────────────────

/** lowercase + trim + collapse whitespace + unify Arabic-market spelling variants. */
export function normalizeItemName(s: string): string {
  return String(s)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\bjel\b/g, 'gel')        // jel ↔ gel (transliteration)
    .replace(/\bjelatin\b/g, 'gelatin')
    .replace(/\binj\.?\b/g, 'inj')
    .replace(/\bsupp\.?\b/g, 'supp')
    .replace(/\bsoln?\.?\b/g, 'solution')
    .replace(/\bconc\.?\b/g, 'conc');
}

// ─── Edit distance ──────────────────────────────────────────────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) curr[j] = prev[j - 1];
      else curr[j] = 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** Similarity ratio in [0,1]. 1 = identical. */
export function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

// ─── Dose-number guard ────────────────────────────────────────────────────────

/**
 * True when the two names have conflicting CORE dose numbers (different strengths).
 * Percentage-concentration patterns ("1%", "%1", "0.1%") are stripped first since
 * they are not dose-distinguishing. The shorter number-list must be a sequential
 * prefix of the longer to be considered "same core" (extra numbers = pack size).
 */
function hasDifferentCoreNumbers(a: string, b: string): boolean {
  const stripConc = (s: string) => s.replace(/\d+(?:\.\d+)?%|%\d+(?:\.\d+)?/g, '');
  const numsA = stripConc(a).match(/\d+/g) || [];
  const numsB = stripConc(b).match(/\d+/g) || [];
  if (numsA.length === 0 || numsB.length === 0) return false;
  const shorter = numsA.length <= numsB.length ? numsA : numsB;
  const longer  = numsA.length <= numsB.length ? numsB : numsA;
  return !shorter.every((n, i) => longer[i] === n);
}

// ─── Word overlap ─────────────────────────────────────────────────────────────

/**
 * Proportion of the shorter name's significant words found in the longer name,
 * ignoring pure-numeric and dose/pack tokens ("25mg", "30tab", "60cap", "50mcg")
 * and percentage tokens. Splits on whitespace, "/" and "-".
 */
function wordOverlapRatio(a: string, b: string): number {
  const DOSE_RE = /^\d+(\w{0,4})?$/;       // "500", "25mg", "30tab", "60cap", "50mcg"
  const CONC_RE = /^%?\d+(?:\.\d+)?%?$/;   // "1%", "%1", "0.1%"
  const sig = (s: string) =>
    s.split(/[\s/-]+/).filter(w => w.length > 2 && !DOSE_RE.test(w) && !CONC_RE.test(w));
  const wa = sig(a), wb = sig(b);
  if (wa.length === 0 || wb.length === 0) return 0;
  const shorter = wa.length <= wb.length ? wa : wb;
  const longer  = wa.length <= wb.length ? wb : wa;
  const wordSim = (w1: string, w2: string) => {
    if (w1.includes(w2) || w2.includes(w1)) return true;
    const maxL = Math.max(w1.length, w2.length);
    if (maxL === 0) return true;
    return 1 - levenshtein(w1, w2) / maxL >= 0.75;
  };
  const matched = shorter.filter(w => longer.some(lw => wordSim(w, lw)));
  return matched.length / shorter.length;
}

// ─── Decision ──────────────────────────────────────────────────────────────────

/**
 * Whether two item names refer to the same product. Mirrors areSimilar() but —
 * unlike the backend — returns true for an exact normalized match too (the
 * backend returns false there because its purpose is flagging duplicates to
 * merge; here exact equality IS a valid match).
 */
export function fuzzyItemMatch(
  nameA: string,
  nameB: string,
  { lev = 0.85, prefixRatio = 0.55, wordOverlap = 0.8 } = {},
): boolean {
  const a = normalizeItemName(nameA);
  const b = normalizeItemName(nameB);

  if (a === b) return true;
  // Block when core dose-numbers conflict (e.g. AIRTIDE 100 vs AIRTIDE 500)
  if (hasDifferentCoreNumbers(a, b)) return false;

  const shorter = a.length <= b.length ? a : b;
  const longer  = a.length <= b.length ? b : a;
  if (longer.startsWith(shorter) && shorter.length / longer.length >= prefixRatio) return true;
  if (similarity(a, b) >= lev) return true;
  if (wordOverlapRatio(a, b) >= wordOverlap) return true;
  return false;
}

// ─── Target ↔ actuals matcher ───────────────────────────────────────────────

interface TargetLike  { itemId: number; itemName: string; target?: number }
interface BreakdownLike { name: string; totalQty: number }

/**
 * Assign each target a quantity from a pool of breakdown rows using greedy 1:1
 * matching: exact-normalized matches claim their row first (pass A), then the
 * remaining targets take their best fuzzy match from the still-unconsumed rows
 * (pass B). Each row is consumed at most once, so two near-duplicate target rows
 * for the same drug never double-count one sales row.
 */
function assignPool(targets: TargetLike[], rows: BreakdownLike[]): Map<number, number> {
  const result = new Map<number, number>();
  const consumed = new Array<boolean>(rows.length).fill(false);
  const normRows = rows.map(r => normalizeItemName(r.name));

  // Pass A — exact normalized match
  const pending: TargetLike[] = [];
  for (const t of targets) {
    const tn = normalizeItemName(t.itemName);
    let hit = -1;
    for (let i = 0; i < rows.length; i++) {
      if (!consumed[i] && normRows[i] === tn) { hit = i; break; }
    }
    if (hit >= 0) { result.set(t.itemId, rows[hit].totalQty); consumed[hit] = true; }
    else pending.push(t);
  }

  // Pass B — best fuzzy match among the rows left over
  for (const t of pending) {
    let best = -1, bestScore = -1;
    for (let i = 0; i < rows.length; i++) {
      if (consumed[i]) continue;
      if (!fuzzyItemMatch(t.itemName, rows[i].name)) continue;
      const score = similarity(normalizeItemName(t.itemName), normRows[i]);
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best >= 0) { result.set(t.itemId, rows[best].totalQty); consumed[best] = true; }
  }

  return result;
}

/**
 * Build a Map<itemId, netQty> for the target-vs-sales table.
 * netQty = matched sales qty − matched returns qty, matched per the rules above.
 */
export function buildTargetActuals(
  targets: TargetLike[],
  salesRows: BreakdownLike[],
  retRows: BreakdownLike[],
): Map<number, number> {
  const salesAssign = assignPool(targets, salesRows ?? []);
  const retAssign   = assignPool(targets, retRows ?? []);
  const net = new Map<number, number>();
  for (const t of targets) {
    net.set(t.itemId, (salesAssign.get(t.itemId) ?? 0) - (retAssign.get(t.itemId) ?? 0));
  }
  return net;
}
