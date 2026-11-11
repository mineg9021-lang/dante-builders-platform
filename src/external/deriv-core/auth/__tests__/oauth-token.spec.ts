import { exchangeCodeForTokens, refreshAccessToken, OAuthError } from '../oauth';

describe('Deriv OAuth browser credential boundary', () => {
  it('disables direct browser authorization-code exchange', async () => {
    await expect(exchangeCodeForTokens({
      code: 'authorization-code', clientId: 'app-id',
      redirectUri: 'https://partner.example.com', codeVerifier: 'pkce-verifier',
    })).rejects.toBeInstanceOf(OAuthError);
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it('requires reauthorization instead of attempting an unsupported refresh-token grant', async () => {
    await expect(refreshAccessToken('old-refresh-token', 'app-id'))
      .rejects.toThrow('Deriv OAuth sessions must be reauthorized after expiry.');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
