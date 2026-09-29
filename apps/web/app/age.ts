export const LEGAL_AGE = 21;

/** Today's calendar date (YYYY-MM-DD) in the store's time zone, falling back to the device's local date. */
export function todayInZone(timeZone: string | undefined, now: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    return `${value('year')}-${value('month')}-${value('day')}`;
  } catch {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }
}

/** Latest birth date (YYYY-MM-DD) that is 21 or older today. A Feb 29 anniversary falls back to Feb 28. */
export function latestEligibleBirthDate(todayIso: string, age = LEGAL_AGE): string {
  const [year, month, day] = todayIso.split('-').map(Number) as [number, number, number];
  const targetYear = year - age;
  const leap = (targetYear % 4 === 0 && targetYear % 100 !== 0) || targetYear % 400 === 0;
  const safeDay = month === 2 && day === 29 && !leap ? 28 : day;
  return `${String(targetYear).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(safeDay).padStart(2, '0')}`;
}

export type AgeResult = { status: 'incomplete' } | { status: 'invalid'; reason: string } | { status: 'ok'; age: number; eligible: boolean };

/** Evaluates a typed date of birth against today's date. Nothing is stored. */
export function evaluateBirthDate(input: { month: string; day: string; year: string }, todayIso: string, minimumAge = LEGAL_AGE): AgeResult {
  if (!input.month || !input.day || input.year.length < 4) return { status: 'incomplete' };
  const [month, day, year] = [Number(input.month), Number(input.day), Number(input.year)];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (!Number.isInteger(month) || !Number.isInteger(day) || !Number.isInteger(year) || year < 1900 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return { status: 'invalid', reason: 'That is not a real date.' };
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (iso > todayIso) return { status: 'invalid', reason: 'That date is in the future.' };
  const [tYear, tMonth, tDay] = todayIso.split('-').map(Number) as [number, number, number];
  const age = tYear - year - (tMonth < month || (tMonth === month && tDay < day) ? 1 : 0);
  return { status: 'ok', age, eligible: iso <= latestEligibleBirthDate(todayIso, minimumAge) };
}

export function formatUsDate(iso: string): string {
  const [year, month, day] = iso.split('-');
  return `${month}/${day}/${year}`;
}
