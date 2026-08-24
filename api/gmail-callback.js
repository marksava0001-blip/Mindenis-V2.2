// ============================================================
// GET /api/gmail-callback?code=...
// Receives the OAuth code from Google, exchanges it for tokens, and
// stores the refresh token SERVER-SIDE ONLY (via the Supabase
// service_role key, in a table with no anon access) — unlike the
// WHOOP integration, the token never touches the browser or the
// public anon-key sync path, since Gmail read access is far more
// sensitive than fitness data.
//
// Env vars required on Vercel:
//   GMAIL_CLIENT_ID
//   GMAIL_CLIENT_SECRET
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY  (the SECRET service_role key — never
//                               the anon/publishable one)
// ============================================================
export default async function handler(req, res) {
  const code = req.query && req.query.code;
  const errorParam = req.query && req.query.error;
  if (errorParam) return res.status(400).send('Google auth error: ' + errorParam);
  if (!code) return res.status(400).send('Missing code parameter.');

  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!clientId || !clientSecret) return res.status(500).send('Server not configured (missing GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET).');
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).send('Server not configured (missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).');

  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const redirectUri = proto + '://' + host + '/api/gmail-callback';

  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    });
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await tokenRes.text();
    if (!tokenRes.ok) return res.status(500).send('Google token exchange failed: ' + text);
    let json;
    try { json = JSON.parse(text); } catch (e) { return res.status(500).send('Google returned non-JSON: ' + text); }

    const refreshToken = json.refresh_token;
    if (!refreshToken) {
      // Google only issues a refresh_token the FIRST time a user consents
      // (or if forced via prompt=consent, which the connect link always
      // passes) — if it's missing, the safest recovery is to have them
      // revoke access at myaccount.google.com/permissions and reconnect.
      return res.status(500).send('No refresh_token returned — revoke this app\'s access at myaccount.google.com/permissions and try connecting again.');
    }

    const upsertRes = await fetch(SUPABASE_URL + '/rest/v1/gmail_tokens?on_conflict=id', {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: 'Bearer ' + SERVICE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ id: 'default', refresh_token: refreshToken, updated_at: new Date().toISOString() }),
    });
    if (!upsertRes.ok) return res.status(500).send('Failed to store token: ' + (await upsertRes.text()));

    res.writeHead(302, { Location: '/finance.html?gmail=connected' });
    res.end();
  } catch (e) {
    res.status(500).send('Unexpected error: ' + (e && e.message ? e.message : String(e)));
  }
}
