jest.mock('@/services/derivws-accounts.service', () => ({
    DerivWSAccountsService: {
        getAuthenticatedWebSocketURL: jest.fn(),
    },
}));

jest.mock('@/external/deriv-core', () => ({
    getAuthInfo: jest.fn(),
    getStoredAuthInfo: jest.fn(),
    refreshAccessToken: jest.fn(),
}));

import { getAuthInfo, getStoredAuthInfo, refreshAccessToken } from '@/external/deriv-core';
import { DerivWSAccountsService } from '@/services/derivws-accounts.service';
import { getSocketURL } from '../config';

describe('getSocketURL authenticated connection handling', () => {
    const previousEnvironment = process.env.NEXT_PUBLIC_DERIV_ENV;
    const previousAppId = process.env.NEXT_PUBLIC_DERIV_APP_ID;

    beforeEach(() => {
        process.env.NEXT_PUBLIC_DERIV_ENV = 'staging';
        process.env.NEXT_PUBLIC_DERIV_APP_ID = 'test-app-id';
        jest.clearAllMocks();
        (getStoredAuthInfo as jest.Mock).mockReturnValue(null);
    });

    afterAll(() => {
        if (previousEnvironment === undefined) {
            delete process.env.NEXT_PUBLIC_DERIV_ENV;
        } else {
            process.env.NEXT_PUBLIC_DERIV_ENV = previousEnvironment;
        }
        if (previousAppId === undefined) {
            delete process.env.NEXT_PUBLIC_DERIV_APP_ID;
        } else {
            process.env.NEXT_PUBLIC_DERIV_APP_ID = previousAppId;
        }
    });

    it('uses the public socket only when no Deriv session exists', async () => {
        (getAuthInfo as jest.Mock).mockReturnValue(null);

        const url = await getSocketURL();

        expect(url).toContain('/options/ws/public');
        expect(DerivWSAccountsService.getAuthenticatedWebSocketURL).not.toHaveBeenCalled();
    });

    it('refreshes an expired stored session before requesting an authenticated socket', async () => {
        const expiredSession = {
            access_token: 'expired-access-token',
            refresh_token: 'stored-refresh-token',
            expires_at: 1,
            scope: 'trade',
        };
        (getStoredAuthInfo as jest.Mock).mockReturnValue(expiredSession);
        (refreshAccessToken as jest.Mock).mockResolvedValue({
            access_token: 'refreshed-access-token',
            refresh_token: 'rotated-refresh-token',
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            expires_in: 3600,
            token_type: 'Bearer',
            scope: 'trade',
        });
        (DerivWSAccountsService.getAuthenticatedWebSocketURL as jest.Mock)
            .mockResolvedValue('wss://authenticated.example.test');

        await expect(getSocketURL()).resolves.toBe('wss://authenticated.example.test');
        expect(refreshAccessToken).toHaveBeenCalledWith(
            'stored-refresh-token',
            'test-app-id'
        );
        expect(DerivWSAccountsService.getAuthenticatedWebSocketURL)
            .toHaveBeenCalledWith('refreshed-access-token');
    });

    it('does not fall back to a public socket when refresh fails', async () => {
        (getStoredAuthInfo as jest.Mock).mockReturnValue({
            access_token: 'expired-access-token',
            refresh_token: 'stored-refresh-token',
            expires_at: 1,
            scope: 'trade',
        });
        (refreshAccessToken as jest.Mock).mockRejectedValue(new Error('temporary network error'));

        await expect(getSocketURL()).rejects.toThrow('DERIV_AUTHENTICATED_CONNECTION_FAILED');
        expect(DerivWSAccountsService.getAuthenticatedWebSocketURL).not.toHaveBeenCalled();
    });

    it('rejects when an authenticated socket cannot be created instead of downgrading', async () => {
        (getStoredAuthInfo as jest.Mock).mockReturnValue({
            access_token: 'test-access-token',
            refresh_token: 'test-refresh-token',
            expires_at: Math.floor(Date.now() / 1000) + 3600,
        });
        (DerivWSAccountsService.getAuthenticatedWebSocketURL as jest.Mock)
            .mockRejectedValue(new Error('provider failure'));

        await expect(getSocketURL()).rejects.toThrow('DERIV_AUTHENTICATED_CONNECTION_FAILED');
    });
});
