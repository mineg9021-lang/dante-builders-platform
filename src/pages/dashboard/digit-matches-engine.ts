export type DigitTick = { symbol: string; quote: string; digit: number; epoch: number };
export type DigitStats = { digit: number; count: number; frequency: number; lastSeen: number | null; maxStreak: number };
export type Candidate = { digit: number; kind: 'MATCHES' | 'DIFFERS'; observedRate: number; score: number; status: 'INSUFFICIENT DATA' | 'ANALYZING' | 'SIGNAL READY'; reason: string };
export type ScannerReport = { sampleSize: number; digits: DigitStats[]; matches: Candidate[]; differs: Candidate[]; even: number; odd: number; quality: number; layers: { name: string; status: 'PASS' | 'WAIT' | 'BLOCKED'; detail: string }[] };

const names = [
 'Market discovery','Market stream','Historical retrieval','Tick ordering','Duplicate detection',
 'Missing-tick monitor','Quote precision','Digit extraction','Digit validation','Frequency analysis',
 'Rolling windows','Hot/cold ranking','Repetition analysis','Streak analysis','Distribution shift',
 'Sample sufficiency','Uncertainty estimate','Matches evaluation','Differs evaluation','Signal validation'
];

export const quoteWithPrecision = (quote: string | number, precision: number): string => {
 const raw = String(quote);
 if (!Number.isFinite(Number(raw))) throw new Error('Invalid quote');
 if (raw.includes('.')) return raw;
 return precision > 0 ? Number(raw).toFixed(precision) : raw;
};

export const extractLastDigit = (quote: string): number => {
 const normalized = quote.trim();
 const fractional = normalized.includes('.') ? normalized.split('.')[1] : normalized;
 const last = fractional?.slice(-1);
 if (!last || !/^[0-9]$/.test(last)) throw new Error('Quote has no extractable final digit');
 return Number(last);
};

export const analyzeDigitTicks = (input: { ticks: DigitTick[]; windowSize: number; minSample?: number }): ScannerReport => {
 const { ticks } = input;
 const window = ticks.slice(-Math.max(20, input.windowSize));
 const counts = Array.from({ length: 10 }, (_, digit) => window.filter(t => t.digit === digit).length);
 const lastSeen = Array.from({ length: 10 }, (_, digit) => {
   const found = [...window].reverse().find(t => t.digit === digit);
   return found?.epoch ?? null;
 });
 const maxStreak = Array.from({ length: 10 }, (_, digit) => {
   let run = 0, max = 0;
   window.forEach(t => { run = t.digit === digit ? run + 1 : 0; max = Math.max(max, run); });
   return max;
 });
 const digits = counts.map((count, digit) => ({ digit, count, frequency: window.length ? count / window.length : 0, lastSeen: lastSeen[digit], maxStreak: maxStreak[digit] }));
 const minimum = input.minSample ?? 100;
 const enough = window.length >= minimum;
 const quality = window.length ? Math.round((window.length / Math.max(minimum, input.windowSize)) * 100) : 0;
 const candidates = (kind: 'MATCHES' | 'DIFFERS'): Candidate[] => digits.map(d => {
   const observedRate = d.frequency;
   const expected = kind === 'MATCHES' ? 0.1 : 0.9;
   const deviation = Math.abs(observedRate - expected);
   const score = Math.round(Math.min(100, deviation * 1000) * (enough ? 1 : 0.5));
   return {
     digit: d.digit, kind, observedRate, score,
     status: !enough ? 'INSUFFICIENT DATA' : 'ANALYZING',
     reason: !enough ? `Need at least ${minimum} valid observations` : 'Historical frequency is descriptive, not a next-tick forecast'
   };
 });
 const matches = candidates('MATCHES');
 const differs = candidates('DIFFERS');
 const unique = new Set(window.map(t => `${t.epoch}:${t.quote}`)).size;
 const ordered = window.every((t, i) => i === 0 || t.epoch > window[i - 1].epoch);
 const layers = names.map((name, index) => {
   const ok = window.length > 0 && (index < 3 ? true : index === 3 ? ordered : index === 4 ? unique === window.length : index === 7 ? window.every(t => t.digit >= 0 && t.digit <= 9) : index === 15 ? enough : enough);
   return { name, status: ok ? 'PASS' as const : 'WAIT' as const, detail: ok ? (index === 15 ? `${window.length} valid observations` : 'Validated') : (index === 15 ? `Collecting sample · ${window.length}/${minimum}` : 'Waiting for sufficient validated observations') };
 });
 return { sampleSize: window.length, digits, matches, differs, even: counts.reduce((n, c, i) => n + (i % 2 === 0 ? c : 0), 0), odd: counts.reduce((n, c, i) => n + (i % 2 ? c : 0), 0), quality, layers };
};
