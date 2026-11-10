import { DerivWSAccountsService, type DerivAccount } from '../derivws-accounts.service';

jest.mock('@/components/shared', () => ({
    isProduction: () => true,
}));

const accounts: DerivAccount[] = [
    {
        account_id: 'VRTC12345',
        account_type: 'demo',
        balance: '10000.00',
        currency: 'USD',
        group: 'financial',
        status: 'active',
    },
    {
        account_id: 'CRW12345',
        account_type: 'real',
        balance: '25.00',
        currency: 'USD',
        group: 'financial',
        status: 'active',
    },
];

describe('Deriv authenticated WebSocket account selection', () => {
    beforeEach(() => {
        DerivWSAccountsService.clearCache();
        DerivWSAccountsService.clearStoredAccounts();
        localStorage.clear();
        jest.clearAllMocks();
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            statusText: 'OK',
            json: async () => ({ data: { url: 'wss://authenticated.derivws.com/session' } }),
        });
    });

    afterEach(() => {
        DerivWSAccountsService.clearCache();
    });

    it.each([
        ['VRTC12345', 'demo'],
        ['CRW12345', 'real'],
    ] as const)('requests the OTP for the selected %s account', async (accountId, accountType) => {
        DerivWSAccountsService.storeAccounts(accounts);
        localStorage.setItem('active_loginid', accountId);

        await expect(
            DerivWSAccountsService.getAuthenticatedWebSocketURL('oauth-access-token')
        ).resolves.toBe('wss://authenticated.derivws.com/session');

        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining(`options/accounts/${accountId}/otp`),
            expect.objectContaining({
                method: 'POST',
                headers: { Authorization: 'Bearer oauth-access-token' },
            })
        );
        expect(localStorage.getItem('account_type')).toBe(accountType);
    });

    it('rejects a stale selected account instead of silently connecting to the first account', async () => {
        DerivWSAccountsService.storeAccounts(accounts);
        localStorage.setItem('active_loginid', 'REMOVED_ACCOUNT');

        await expect(
            DerivWSAccountsService.getAuthenticatedWebSocketURL('oauth-access-token')
        ).rejects.toThrow('SELECTED_DERIV_ACCOUNT_NOT_AVAILABLE');

        expect(global.fetch).not.toHaveBeenCalled();
        expect(localStorage.getItem('account_type')).toBeNull();
    });

    it('uses the first Deriv account only when no account has been selected yet', async () => {
        DerivWSAccountsService.storeAccounts(accounts);

        await DerivWSAccountsService.getAuthenticatedWebSocketURL('oauth-access-token');

        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('options/accounts/VRTC12345/otp'),
            expect.any(Object)
        );
        expect(localStorage.getItem('account_type')).toBe('demo');
    });
});
