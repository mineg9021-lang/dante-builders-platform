import { isProduction } from '@/components/shared';
import brandConfig from '../../brand.config.json';

export interface DerivAccount {
    account_id: string;
    balance: string;
    currency: string;
    group: string;
    status: string;
    account_type: 'demo' | 'real';
}

interface AccountsResponse {
    data: DerivAccount[];
}

interface OTPResponse {
    data: { url: string };
}

/**
 * DerivWS account operations.
 *
 * Promise caches are scoped to the access token as well as the account. They
 * only deduplicate concurrent requests; settled promises are immediately
 * evicted so a later authorization always gets fresh account/OTP data.
 */
export class DerivWSAccountsService {
    private static accountsFetchPromises = new Map<string, Promise<DerivAccount[]>>();
    private static otpFetchPromises = new Map<string, Promise<string>>();

    private static getDerivWSBaseURL(): string {
        const environment = isProduction() ? 'production' : 'staging';
        return brandConfig.platform.derivws.url[environment];
    }

    static clearCache(): void {
        this.accountsFetchPromises.clear();
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
            return Array.isArray(parsed) ? (parsed as DerivAccount[]) : null;
        } catch (error) {
            console.error('[DerivWS] Error parsing stored accounts:', error);
            return null;
        }
    }

    static getDefaultAccount(): DerivAccount | null {
        return this.getStoredAccounts()?.[0] ?? null;
    }

    static clearStoredAccounts(): void {
        sessionStorage.removeItem('deriv_accounts');
    }

    static async fetchAccountsList(accessToken: string): Promise<DerivAccount[]> {
        if (!accessToken) throw new Error('DERIV_ACCESS_TOKEN_REQUIRED');
        const existing = this.accountsFetchPromises.get(accessToken);
        if (existing) return existing;

        const request = (async () => {
            const baseURL = this.getDerivWSBaseURL();
            const optionsDir = brandConfig.platform.derivws.directories.options;
            const endpoint = `${baseURL}${optionsDir}accounts`;
            const response = await fetch(endpoint, {
                method: 'GET',
                headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (!response.ok) {
                throw new Error(`Failed to fetch accounts: ${response.status} ${response.statusText}`);
            }

            const payload: AccountsResponse = await response.json();
            const accounts = payload?.data;
            if (!Array.isArray(accounts)) {
                throw new Error('DERIV_ACCOUNTS_RESPONSE_INVALID');
            }
            this.storeAccounts(accounts);
            return accounts;
        })();

        this.accountsFetchPromises.set(accessToken, request);
        try {
            return await request;
        } finally {
            if (this.accountsFetchPromises.get(accessToken) === request) {
                this.accountsFetchPromises.delete(accessToken);
            }
        }
    }

    static async fetchOTPWebSocketURL(accessToken: string, accountId: string): Promise<string> {
        if (!accessToken) throw new Error('DERIV_ACCESS_TOKEN_REQUIRED');
        if (!accountId) throw new Error('DERIV_ACCOUNT_ID_REQUIRED');
        const cacheKey = `${accessToken}::${accountId}`;
        const existing = this.otpFetchPromises.get(cacheKey);
        if (existing) return existing;

        const request = (async () => {
            const baseURL = this.getDerivWSBaseURL();
            const optionsDir = brandConfig.platform.derivws.directories.options;
            const endpoint = `${baseURL}${optionsDir}accounts/${encodeURIComponent(accountId)}/otp`;
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (!response.ok) {
                throw new Error(`Failed to fetch OTP: ${response.status} ${response.statusText}`);
            }
            const payload: OTPResponse = await response.json();
            const websocketURL = payload?.data?.url;
            if (!websocketURL) throw new Error('DERIV_WEBSOCKET_URL_MISSING');
            return websocketURL;
        })();

        this.otpFetchPromises.set(cacheKey, request);
        try {
            return await request;
        } finally {
            if (this.otpFetchPromises.get(cacheKey) === request) {
                this.otpFetchPromises.delete(cacheKey);
            }
        }
    }

    /**
     * Always refresh the account list with the current OAuth token. sessionStorage
     * is a display/cache convenience only and is never trusted for authorization.
     */
    static async getAuthenticatedWebSocketURL(accessToken: string): Promise<string> {
        try {
            const accounts = await this.fetchAccountsList(accessToken);
            if (accounts.length === 0) throw new Error('No accounts available');

            const activeLoginId = localStorage.getItem('active_loginid');
            const targetAccount = activeLoginId
                ? accounts.find(account => account.account_id === activeLoginId)
                : accounts[0];

            if (!targetAccount) throw new Error('SELECTED_DERIV_ACCOUNT_NOT_AVAILABLE');
            if (targetAccount.account_type !== 'demo' && targetAccount.account_type !== 'real') {
                throw new Error('DERIV_ACCOUNT_TYPE_UNVERIFIED');
            }

            localStorage.setItem('account_type', targetAccount.account_type);
            return await this.fetchOTPWebSocketURL(accessToken, targetAccount.account_id);
        } catch (error) {
            console.error('[DerivWS] Error in authenticated WebSocket URL flow:', error);
            throw error;
        }
    }
}
