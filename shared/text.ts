/**
 * Deterministic text normalisation shared by the product matcher, alias
 * dictionary and search. The same function is applied to both the stored
 * alias and the incoming phrase, so "Rib-Eyes" and "rib eye" meet in the middle.
 */
const KEEP_S = /(ss|us|is|ous)$/;

export function singularise(word: string): string {
  if (word.length <= 3) return word;
  if (KEEP_S.test(word)) return word;
  if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';
  if (word.endsWith('ches') || word.endsWith('shes') || word.endsWith('xes')) return word.slice(0, -2);
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

export function normalise(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’'`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(singularise)
    .join(' ');
}

export function tokens(input: string): string[] {
  const n = normalise(input);
  return n ? n.split(' ') : [];
}

export function levenshtein(a: string, b: string, max = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = i;
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
      if (prev[j] < rowMin) rowMin = prev[j];
    }
    if (rowMin > max) return max + 1;
  }
  return prev[b.length];
}

/** How many typos we tolerate for a word of this length. Short words must match exactly. */
export function typoAllowance(len: number): number {
  if (len <= 3) return 0;
  if (len <= 6) return 1;
  return 2;
}

export function fuzzyWordEqual(a: string, b: string): boolean {
  if (a === b) return true;
  const allow = Math.min(typoAllowance(a.length), typoAllowance(b.length));
  if (allow === 0) return false;
  // first letter must match — avoids "rump"≈"lump" style surprises
  if (a[0] !== b[0]) return false;
  return levenshtein(a, b, allow) <= allow;
}

export function normalisePhone(raw: string | null | undefined, defaultCountry = '27'): string | null {
  if (!raw) return null;
  let digits = raw.replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = defaultCountry + digits.slice(1);
  if (digits.length < 9 || digits.length > 15) return null;
  return '+' + digits;
}

export function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/(\s+|-)/)
    .map((w) => (w.trim() && w !== '-' ? w[0].toUpperCase() + w.slice(1) : w))
    .join('');
}
