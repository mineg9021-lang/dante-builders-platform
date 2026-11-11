import { checkSameOrigin, clearOAuthCookie, config, constantTimeEqual, json, readOAuthCookie, requireDanteUser, saveDerivToken } from './_shared/deriv-oauth.mjs';

export default async request => {
  if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  if (!checkSameOrigin(request)) return json({ error: 'INVALID_ORIGIN' }, 403);
  const user = await requireDanteUser(request);
  if (!user) return json({ error: 'DANTE_LOGIN_REQUIRED' }, 401);
  const transaction = readOAuthCookie(request);
  if (!transaction || transaction.userId !== user.id || Date.now() - transaction.createdAt > 10 * 60 * 1000) {
    return json({ error: 'OAUTH_TRANSACTION_EXPIRED' }, 400, { 'Set-Cookie': clearOAuthCookie });
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: 'INVALID_JSON' }, 400, { 'Set-Cookie': clearOAuthCookie }); }
  if (typeof body?.state !== 'string' || !constantTimeEqual(body.state, transaction.state) || typeof body?.code !== 'string' || body.code.length > 4096) {
    return json({ error: 'OAUTH_STATE_INVALID' }, 400, { 'Set-Cookie': clearOAuthCookie });
  }
  try {
    const cfg = config();
    const tokenResponse = await fetch(cfg.authBase + '/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', client_id: cfg.clientId, code: body.code,
        redirect_uri: cfg.redirectUri, code_verifier: transaction.verifier,
      }).toString(),
    });
    if (!tokenResponse.ok) return json({ error: 'DERIV_TOKEN_EXCHANGE_FAILED', reauthorizationRequired: true }, 401, { 'Set-Cookie': clearOAuthCookie });
    const token = await tokenResponse.json();
    if (typeof token.access_token !== 'string' || token.token_type?.toLowerCase() !== 'bearer' ||
        typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
      return json({ error: 'DERIV_TOKEN_RESPONSE_INVALID' }, 502, { 'Set-Cookie': clearOAuthCookie });
    }
    const expiresAt = Math.floor(Date.now() / 1000) + token.expires_in;
    await saveDerivToken(user.id, { access_token: token.access_token, expires_at: expiresAt, scope: typeof token.scope === 'string' ? token.scope : 'trade' });
    return json({ connected: true, expiresAt }, 200, { 'Set-Cookie': clearOAuthCookie });
  } catch {
    return json({ error: 'DERIV_CONNECTION_NOT_CONFIGURED' }, 503, { 'Set-Cookie': clearOAuthCookie });
  }
};
