import { buildAuthorizationUrl, buildSignUpUrl, handleOAuthCallback, OAuthError } from '../oauth';
import type { AuthConfig } from '../../types';

const config: AuthConfig = { clientId: 'app-id', redirectUri: 'https://partner.example.com' };
const authorizationUrl = 'https://auth.deriv.com/oauth2/auth?state=server-state';

describe('server-managed OAuth authorization', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, json: async () => ({ authorizationUrl }),
    } as Response);
  });
  it.each([buildAuthorizationUrl, buildSignUpUrl])('requests a backend-generated PKCE URL', async build => {
    await expect(build({ ...config, lang: 'fr' })).resolves.toBe(authorizationUrl);
    expect(fetch).toHaveBeenCalledWith('/.netlify/functions/deriv-oauth-start', expect.objectContaining({
      method: 'POST', credentials: 'same-origin',
      body: JSON.stringify({ mode: build === buildSignUpUrl ? 'signup' : 'login', lang: 'fr', affiliateToken: undefined, affiliateTokenParam: undefined }),
    }));
  });
  it('forwards partner attribution to the backend, not to browser-generated OAuth parameters', async () => {
    await buildAuthorizationUrl({ ...config, lang: 'es', affiliateToken: 'partner-code', affiliateTokenParam: 'sidi' });
    expect(JSON.parse(String((fetch as jest.Mock).mock.calls[0][1].body))).toMatchObject({
      lang: 'es', affiliateToken: 'partner-code', affiliateTokenParam: 'sidi',
    });
  });
  it('rejects when the backend cannot start a secure transaction', async () => {
    (fetch as jest.Mock).mockResolvedValueOnce({ ok: false, json: async () => ({ message: 'Dante login required' }) });
    await expect(buildAuthorizationUrl(config)).rejects.toThrow('Dante login required');
  });
});

describe('server-managed OAuth callback', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, json: async () => ({ connected: true }),
    } as Response);
  });
  it('rejects a callback from an unexpected origin before contacting the backend', async () => {
    await expect(handleOAuthCallback('https://attacker.example.com/?code=c&state=s', config))
      .rejects.toThrow(new OAuthError('OAuth callback URL does not match the configured redirect URI'));
    expect(fetch).not.toHaveBeenCalled();
  });
  it('posts the code and state to the backend without exchanging tokens in the browser', async () => {
    await handleOAuthCallback('https://partner.example.com/?code=auth-code&state=server-state', config);
    expect(fetch).toHaveBeenCalledWith('/.netlify/functions/deriv-oauth-callback', expect.objectContaining({
      method: 'POST', credentials: 'same-origin',
      body: JSON.stringify({ code: 'auth-code', state: 'server-state' }),
    }));
  });
});
