import { DerivWSAccountsService, type DerivAccount } from '../derivws-accounts.service';

jest.mock('@/components/shared', () => ({
    isProduction: () => true,
}));

const accounts: DerivAccount[] = [
    { account_id: 'VRTC12345', account_type: 'demo', balance: '10000.00', currency: 'USD', group: 'financial', status: 'active' },
    { account_id: 'CRW12345', account_type: 'real', balance: '25.00', currency: 'USD', group: 'financial', status: 'active' },
];

const otpResponse = { data: { url: 'wss://authenticated.derivws.com/session' } };

describe('Deriv authenticated WebSocket account selection', () => {
    beforeEach(() => {
        DerivWSAccountsService.clearCache();
        DerivWSAccountsService.clearStoredAccounts();
        localStorage.clear();
        jest.clearAllMocks();
        (global.fetch as jest.Mock).mockImplementation(async (url: string) => ({
            ok: true,
            statusText: 'OK',
            json: async () => String(url).includes('/otp') ? otpResponse : { data: accounts },
        }));
    });

    afterEach(() => {
        DerivWSAccountsService.clearCache();
        DerivWSAccountsService.clearStoredAccounts();
    });

    it.each([
        ['VRTC12345', 'demo'],
        ['CRW12345', 'real'],
    ] as const)('requests the OTP for the selected %s account', async (accountId, accountType) => {
        localStorage.setItem('active_loginid', accountId);

        await expect(DerivWSAccountsService.getAuthenticatedWebSocketURL('oauth-access-token'))
            .resolves.toBe(otpResponse.data.url);

        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('options/accounts'),
            expect.objectContaining({ method: 'GET', headers: { Authorization: 'Bearer oauth-access-token' } })
        );
        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining(`options/accounts/${accountId}/otp`),
            expect.objectContaining({ method: 'POST', headers: { Authorization: 'Bearer oauth-access-token' } })
        );
        expect(localStorage.getItem('account_type')).toBe(accountType);
    });

    it('rejects a stale selected account instead of silently connecting to the first account', async () => {
        localStorage.setItem('active_loginid', 'REMOVED_ACCOUNT');

        await expect(DerivWSAccountsService.getAuthenticatedWebSocketURL('oauth-access-token'))
            .rejects.toThrow('SELECTED_DERIV_ACCOUNT_NOT_AVAILABLE');

        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(String((global.fetch as jest.Mock).mock.calls[0][0])).not.toContain('/otp');
        expect(localStorage.getItem('account_type')).toBeNull();
    });

    it('uses the first freshly returned Deriv account only when no account has been selected', async () => {
        await DerivWSAccountsService.getAuthenticatedWebSocketURL('oauth-access-token');

        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('options/accounts/VRTC12345/otp'),
            expect.any(Object)
        );
        expect(localStorage.getItem('account_type')).toBe('demo');
    });

    it('does not reuse an in-flight account request across different OAuth tokens', async () => {
        const seenAuthorization: string[] = [];
        (global.fetch as jest.Mock).mockImplementation(async (_url: string, options: RequestInit) => {
            seenAuthorization.push(String(options.headers && (options.headers as Record<string, string>).Authorization));
            return { ok: true, statusText: 'OK', json: async () => ({ data: accounts }) };
        });

        await Promise.all([
            DerivWSAccountsService.fetchAccountsList('token-one'),
            DerivWSAccountsService.fetchAccountsList('token-two'),
        ]);

        expect(seenAuthorization).toEqual(['Bearer token-one', 'Bearer token-two']);
    });

    it('does not reuse an OTP request across different OAuth tokens', async () => {
        const seenAuthorization: string[] = [];
        (global.fetch as jest.Mock).mockImplementation(async (_url: string, options: RequestInit) => {
            seenAuthorization.push(String(options.headers && (options.headers as Record<string, string>).Authorization));
            return { ok: true, statusText: 'OK', json: async () => otpResponse };
        });

        await Promise.all([
            DerivWSAccountsService.fetchOTPWebSocketURL('token-one', 'VRTC12345'),
            DerivWSAccountsService.fetchOTPWebSocketURL('token-two', 'VRTC12345'),
        ]);

        expect(seenAuthorization).toEqual(['Bearer token-one', 'Bearer token-two']);
    });

    it('rejects malformed account-list responses', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            statusText: 'OK',
            json: async () => ({ data: null }),
        });

        await expect(DerivWSAccountsService.fetchAccountsList('oauth-access-token'))
            .rejects.toThrow('DERIV_ACCOUNTS_RESPONSE_INVALID');
    });
});
