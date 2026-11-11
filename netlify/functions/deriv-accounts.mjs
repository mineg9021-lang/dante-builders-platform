import { config, getDerivToken, json, requireDanteUser } from './_shared/deriv-oauth.mjs';

export default async request => {
  if (request.method !== 'GET') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  const user = await requireDanteUser(request);
  if (!user) return json({ error: 'DANTE_LOGIN_REQUIRED' }, 401);
  try {
    const token = await getDerivToken(user.id);
    if (!token) return json({ error: 'DERIV_REAUTHORIZATION_REQUIRED', reauthorizationRequired: true }, 401);
    const cfg = config();
    const response = await fetch(cfg.apiBase + '/accounts', { headers: { Authorization: 'Bearer ' + token.access_token, 'Deriv-App-ID': cfg.clientId } });
    if (response.status === 401) return json({ error: 'DERIV_REAUTHORIZATION_REQUIRED', reauthorizationRequired: true }, 401);
    if (!response.ok) return json({ error: 'DERIV_ACCOUNTS_UNAVAILABLE' }, 502);
    const payload = await response.json();
    if (!Array.isArray(payload?.data)) return json({ error: 'DERIV_ACCOUNTS_RESPONSE_INVALID' }, 502);
    return json({ data: payload.data.map(account => ({
      account_id: account.account_id, account_type: account.account_type, currency: account.currency,
      balance: account.balance, group: account.group, status: account.status,
    })) });
  } catch {
    return json({ error: 'DERIV_ACCOUNT_SERVICE_UNAVAILABLE' }, 503);
  }
};
