import { DerivWSAccountsService, type DerivAccount } from '../derivws-accounts.service';

const accounts: DerivAccount[] = [
  { account_id: 'VRTC12345', account_type: 'demo', balance: '10000.00', currency: 'USD', group: 'financial', status: 'active' },
  { account_id: 'CRW12345', account_type: 'real', balance: '25.00', currency: 'USD', group: 'financial', status: 'active' },
];

describe('Deriv backend account adapter', () => {
  beforeEach(() => {
    DerivWSAccountsService.clearCache();
    DerivWSAccountsService.clearStoredAccounts();
    localStorage.clear(); sessionStorage.clear(); jest.clearAllMocks();
  });
  it('fetches accounts through the Dante session without sending a bearer token', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ data: accounts }) });
    await expect(DerivWSAccountsService.fetchAccountsList()).resolves.toEqual(accounts);
    expect(fetch).toHaveBeenCalledWith('/.netlify/functions/deriv-accounts', { method: 'GET', credentials: 'same-origin' });
    expect(JSON.stringify((fetch as jest.Mock).mock.calls)).not.toContain('Bearer');
  });
  it('requests a WebSocket URL through the protected backend', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true, json: async () => ({ url: 'wss://authenticated.derivws.com/session', account: { account_id: 'CRW12345', account_type: 'real' } }),
    });
    await expect(DerivWSAccountsService.fetchOTPWebSocketURL(undefined, 'CRW12345'))
      .resolves.toBe('wss://authenticated.derivws.com/session');
    expect(fetch).toHaveBeenCalledWith('/.netlify/functions/deriv-account-otp', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', body: JSON.stringify({ accountId: 'CRW12345' }),
    }));
    expect(localStorage.getItem('account_type')).toBe('real');
  });
  it('rejects malformed account responses', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ data: null }) });
    await expect(DerivWSAccountsService.fetchAccountsList()).rejects.toThrow('DERIV_ACCOUNTS_RESPONSE_INVALID');
  });
});
