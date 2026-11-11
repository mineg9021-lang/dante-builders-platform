import { checkSameOrigin, config, json, pkceChallenge, randomBase64url, requireDanteUser, setOAuthCookie } from './_shared/deriv-oauth.mjs';

export default async request => {
  if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  if (!checkSameOrigin(request)) return json({ error: 'INVALID_ORIGIN' }, 403);
  const user = await requireDanteUser(request);
  if (!user) return json({ error: 'DANTE_LOGIN_REQUIRED' }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'INVALID_JSON' }, 400); }
  try {
    const cfg = config();
    const state = randomBase64url(32);
    const verifier = randomBase64url(48);
    const params = new URLSearchParams({
      response_type: 'code', client_id: cfg.clientId, redirect_uri: cfg.redirectUri,
      scope: 'trade', state, code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256',
    });
    if (body?.mode === 'signup') params.set('prompt', 'registration');
    if (typeof body?.lang === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/i.test(body.lang)) params.set('lang', body.lang.toUpperCase());
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign']) {
      const field = key === 'utm_source' ? 'utmSource' : key === 'utm_medium' ? 'utmMedium' : 'utmCampaign';
      if (typeof body?.[field] === 'string' && body[field].length <= 128) params.set(key, body[field]);
    }
    if (typeof body?.affiliateToken === 'string' && body.affiliateToken.length <= 128) {
      const key = ['t', 'affiliate_token', 'sidi', 'ca'].includes(body.affiliateTokenParam) ? body.affiliateTokenParam : 't';
      params.set(key, body.affiliateToken);
    }
    return json({ authorizationUrl: cfg.authBase + '/auth?' + params.toString() }, 200, { 'Set-Cookie': setOAuthCookie({ state, verifier, userId: user.id, createdAt: Date.now() }) });
  } catch (error) {
    return json({ error: 'DERIV_OAUTH_NOT_CONFIGURED', message: error.message }, 503);
  }
};
