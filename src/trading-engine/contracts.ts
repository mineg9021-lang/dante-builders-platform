/**
 * Contract identifiers accepted by the current Deriv proposal API.
 * Availability is always re-checked per symbol with contracts_for at runtime.
 * This list is an API vocabulary, not a claim that every type is available
 * for every market or that every strategy adapter has been implemented.
 */
export const DERIV_CONTRACT_TYPES = [
    'HIGHER', 'LOWER', 'MULTUP', 'MULTDOWN', 'UPORDOWN', 'EXPIRYRANGE',
    'ONETOUCH', 'CALLE', 'ASIAND', 'EXPIRYRANGEE', 'DIGITDIFF',
    'DIGITMATCH', 'DIGITOVER', 'PUTE', 'DIGITUNDER', 'NOTOUCH',
    'CALL', 'RANGE', 'DIGITODD', 'PUT', 'ASIANU', 'EXPIRYMISSE',
    'EXPIRYMISS', 'DIGITEVEN', 'TICKHIGH', 'TICKLOW', 'RESETCALL',
    'RESETPUT', 'RUNHIGH', 'RUNLOW', 'ACCU', 'VANILLALONGCALL',
    'VANILLALONGPUT', 'TURBOSLONG', 'TURBOSSHORT',
] as const;

export type DerivContractType = (typeof DERIV_CONTRACT_TYPES)[number];

export type AvailableContract = {
    contract_type: string;
    underlying_symbol?: string;
    [key: string]: unknown;
};

export type ContractsForApi = {
    send: (request: Record<string, unknown>) => Promise<any>;
};

/** Ask Deriv, not a local hard-coded list, what this market currently supports. */
export async function discoverContractsForSymbol(
    api: ContractsForApi,
    symbol: string
): Promise<AvailableContract[]> {
    if (!/^[A-Za-z0-9_]{2,30}$/.test(symbol)) {
        throw new Error('INVALID_SYMBOL');
    }
    const response = await api.send({ contracts_for: symbol });
    if (response?.error) {
        throw new Error(String(response.error.message || response.error.code || 'CONTRACT_DISCOVERY_FAILED'));
    }
    const available = response?.contracts_for?.available;
    if (!Array.isArray(available)) {
        throw new Error('INVALID_CONTRACT_DISCOVERY_RESPONSE');
    }
    return available.filter((item: any) =>
        item && typeof item.contract_type === 'string' &&
        (!item.underlying_symbol || item.underlying_symbol === symbol)
    ) as AvailableContract[];
}

export function isContractAvailable(
    available: AvailableContract[],
    contractType: DerivContractType
): boolean {
    return available.some(item => item.contract_type === contractType);
}
