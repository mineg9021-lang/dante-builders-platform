export const MAX_MARTINGALE_STEPS = 3;

export const calculateParityStake = (baseStake: number, enabled: boolean, lossStep: number): number => {
    const multiplier = enabled ? Math.pow(1.5, Math.max(0, Math.min(MAX_MARTINGALE_STEPS, lossStep))) : 1;
    return Number((baseStake * multiplier).toFixed(2));
};

export const advanceMartingaleAfterSettlement = (
    currentStep: number,
    settlement: 'WON' | 'LOST' | 'VOID',
    enabled: boolean
): { nextStep: number; halt: boolean } => {
    if (settlement !== 'LOST' || !enabled) return { nextStep: 0, halt: false };
    if (currentStep >= MAX_MARTINGALE_STEPS) return { nextStep: 0, halt: true };
    return { nextStep: currentStep + 1, halt: false };
};
