export interface DerivAccount {
    account_id: string;
    balance: string;
    currency: string;
    group: string;
    status: string;
    account_type: 'demo' | 'real';
}

interface AccountsResponse { data: DerivAccount[] }
interface OTPResponse { url: string; account: { account_id: string; account_type: 'demo' | 'real' } }

/**
 * Browser-side adapter for protected Dante BFF endpoints.
 * Deriv access tokens never enter this module, its cache keys, or browser storage.
 */
export class DerivWSAccountsService {
    private static accountsFetchPromise: Promise<DerivAccount[]> | null = null;
    private static otpFetchPromises = new Map<string, Promise<string>>();

    static clearCache(): void {
        this.accountsFetchPromise = null;
        this.otpFetchPromises.clear();
    }

    static storeAccounts(accounts: DerivAccount[]): void {
        sessionStorage.setItem('deriv_accounts', JSON.stringify(accounts));
    }

    static getStoredAccounts(): DerivAccount[] | null {
        try {
            const raw = sessionStorage.getItem('deriv_accounts');
            if (!raw) return null;
            const parsed: unknown = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed as DerivAccount[] : null;
        } catch {
            return null;
        }
    }

    static getDefaultAccount(): DerivAccount | null {
        return this.getStoredAccounts()?.[0] ?? null;
    }

    static clearStoredAccounts(): void {
        sessionStorage.removeItem('deriv_accounts');
    }

    static async fetchAccountsList(_legacyAccessToken?: string): Promise<DerivAccount[]> {
        if (this.accountsFetchPromise) return this.accountsFetchPromise;
        const request = (async () => {
            const response = await fetch('/.netlify/functions/deriv-accounts', {
                method: 'GET', credentials: 'same-origin',
            });
            const payload = await response.json().catch(() => ({})) as AccountsResponse & { error?: string };
            if (!response.ok) throw new Error(payload.error || 'DERIV_ACCOUNTS_UNAVAILABLE');
            if (!Array.isArray(payload.data)) throw new Error('DERIV_ACCOUNTS_RESPONSE_INVALID');
            this.storeAccounts(payload.data);
            return payload.data;
        })();
        this.accountsFetchPromise = request;
        try { return await request; }
        finally { if (this.accountsFetchPromise === request) this.accountsFetchPromise = null; }
    }

    static async fetchOTPWebSocketURL(accountOrLegacyToken: string | undefined, maybeAccountId?: string): Promise<string> {
        const accountId = maybeAccountId ?? accountOrLegacyToken ?? '';
        if (!accountId) throw new Error('DERIV_ACCOUNT_ID_REQUIRED');
        const existing = this.otpFetchPromises.get(accountId);
        if (existing) return existing;
        const request = (async () => {
            const response = await fetch('/.netlify/functions/deriv-account-otp', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ accountId }),
            });
            const payload = await response.json().catch(() => ({})) as OTPResponse & { error?: string };
            if (!response.ok || typeof payload.url !== 'string') throw new Error(payload.error || 'DERIV_WEBSOCKET_OTP_UNAVAILABLE');
            const account = payload.account;
            if (account && ['demo', 'real'].includes(account.account_type)) {
                localStorage.setItem('account_type', account.account_type);
            }
            return payload.url;
        })();
        this.otpFetchPromises.set(accountId, request);
        try { return await request; }
        finally { if (this.otpFetchPromises.get(accountId) === request) this.otpFetchPromises.delete(accountId); }
    }

    static async getAuthenticatedWebSocketURL(_legacyAccessToken?: string): Promise<string> {
        const accounts = await this.fetchAccountsList();
        if (!accounts.length) throw new Error('No accounts available');
        const selectedId = localStorage.getItem('active_loginid');
        const selected = selectedId ? accounts.find(account => account.account_id === selectedId) : accounts[0];
        if (!selected) throw new Error('SELECTED_DERIV_ACCOUNT_NOT_AVAILABLE');
        if (!['demo', 'real'].includes(selected.account_type)) throw new Error('DERIV_ACCOUNT_TYPE_UNVERIFIED');
        return this.fetchOTPWebSocketURL(undefined, selected.account_id);
    }
}
