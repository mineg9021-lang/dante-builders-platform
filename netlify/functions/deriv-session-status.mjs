import { getDerivTokenStatus, json, requireDanteUser } from './_shared/deriv-oauth.mjs';

export default async request => {
  if (request.method !== 'GET') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  const user = await requireDanteUser(request);
  if (!user) return json({ error: 'DANTE_LOGIN_REQUIRED' }, 401);
  try { return json(await getDerivTokenStatus(user.id)); }
  catch { return json({ error: 'DERIV_SESSION_STATUS_UNAVAILABLE' }, 503); }
};
