export type DigitMetrics = {
    sampleSize: number;
    counts: number[];
    frequencies: number[];
    mean: number;
    standardDeviation: number;
    entropyBits: number;
    longestStreak: number;
    transitionCount: number;
    transitionMatrix: number[][];
    firstHalfSize: number;
    secondHalfSize: number;
};

export const calculateDigitMetrics = (digits: number[]): DigitMetrics => {
    const clean = digits.filter(digit => Number.isInteger(digit) && digit >= 0 && digit <= 9);
    const counts = Array.from({ length: 10 }, (_, digit) => clean.filter(value => value === digit).length);
    const frequencies = counts.map(count => clean.length ? count / clean.length : 0);
    const mean = clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : 0;
    const variance = clean.length ? clean.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / clean.length : 0;
    const entropyBits = frequencies.reduce((sum, frequency) => frequency > 0 ? sum - frequency * Math.log2(frequency) : sum, 0);
    let longestStreak = 0;
    let currentStreak = 0;
    let previous: number | undefined;
    const transitionMatrix = Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 0));
    for (const digit of clean) {
        currentStreak = digit === previous ? currentStreak + 1 : 1;
        longestStreak = Math.max(longestStreak, currentStreak);
        if (previous !== undefined) transitionMatrix[previous][digit] += 1;
        previous = digit;
    }
    return {
        sampleSize: clean.length, counts, frequencies, mean, standardDeviation: Math.sqrt(variance),
        entropyBits, longestStreak, transitionCount: Math.max(0, clean.length - 1),
        transitionMatrix, firstHalfSize: Math.floor(clean.length / 2), secondHalfSize: clean.length - Math.floor(clean.length / 2),
    };
};
