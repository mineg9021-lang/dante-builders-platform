jest.mock('@/services/derivws-accounts.service', () => ({
    DerivWSAccountsService: {
        getAuthenticatedWebSocketURL: jest.fn(),
    },
}));

jest.mock('@/external/deriv-core', () => ({
    getAuthInfo: jest.fn(),
}));

import { getAuthInfo } from '@/external/deriv-core';
import { DerivWSAccountsService } from '@/services/derivws-accounts.service';
import { getSocketURL } from '../config';

describe('getSocketURL authenticated connection handling', () => {
    const previousEnvironment = process.env.NEXT_PUBLIC_DERIV_ENV;

    beforeEach(() => {
        process.env.NEXT_PUBLIC_DERIV_ENV = 'staging';
        jest.clearAllMocks();
    });

    afterAll(() => {
        if (previousEnvironment === undefined) {
            delete process.env.NEXT_PUBLIC_DERIV_ENV;
        } else {
            process.env.NEXT_PUBLIC_DERIV_ENV = previousEnvironment;
        }
    });

    it('uses the public socket only when no Deriv session exists', async () => {
        (getAuthInfo as jest.Mock).mockReturnValue(null);

        const url = await getSocketURL();

        expect(url).toContain('/options/ws/public');
        expect(DerivWSAccountsService.getAuthenticatedWebSocketURL).not.toHaveBeenCalled();
    });

    it('rejects when an authenticated socket cannot be created instead of downgrading', async () => {
        (getAuthInfo as jest.Mock).mockReturnValue({
            access_token: 'test-access-token',
            expires_at: Math.floor(Date.now() / 1000) + 3600,
        });
        (DerivWSAccountsService.getAuthenticatedWebSocketURL as jest.Mock)
            .mockRejectedValue(new Error('provider failure'));

        await expect(getSocketURL()).rejects.toThrow('DERIV_AUTHENTICATED_CONNECTION_FAILED');
    });
});
