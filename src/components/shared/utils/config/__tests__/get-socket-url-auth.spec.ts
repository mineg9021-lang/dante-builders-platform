jest.mock('@/services/derivws-accounts.service', () => ({
    DerivWSAccountsService: { getAuthenticatedWebSocketURL: jest.fn() },
}));
import { DerivWSAccountsService } from '@/services/derivws-accounts.service';
import { getSocketURL } from '../config';

describe('getSocketURL server-side Deriv session handling', () => {
    beforeEach(() => {
        process.env.NEXT_PUBLIC_DERIV_ENV = 'staging';
        jest.clearAllMocks();
        jest.restoreAllMocks();
    });
    it('uses the public socket only when no Deriv account is connected', async () => {
        jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'not_connected' }) } as Response);
        const url = await getSocketURL();
        expect(url).toContain('/options/ws/public');
        expect(DerivWSAccountsService.getAuthenticatedWebSocketURL).not.toHaveBeenCalled();
    });
    it('uses the protected one-time OTP path for a connected Deriv session', async () => {
        jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'connected' }) } as Response);
        (DerivWSAccountsService.getAuthenticatedWebSocketURL as jest.Mock).mockResolvedValue('wss://authenticated.example.test');
        await expect(getSocketURL()).resolves.toBe('wss://authenticated.example.test');
        expect(DerivWSAccountsService.getAuthenticatedWebSocketURL).toHaveBeenCalledWith();
    });
    it('requires reauthorization for an expired Deriv token and never downgrades to public', async () => {
        jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'reauthorization_required' }) } as Response);
        await expect(getSocketURL()).rejects.toThrow('DERIV_REAUTHORIZATION_REQUIRED');
        expect(DerivWSAccountsService.getAuthenticatedWebSocketURL).not.toHaveBeenCalled();
    });
    it('uses the public market socket before Dante sign-in', async () => {
        jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: 'DANTE_LOGIN_REQUIRED' }) } as Response);
        await expect(getSocketURL()).resolves.toContain('/options/ws/public');
    });
});
