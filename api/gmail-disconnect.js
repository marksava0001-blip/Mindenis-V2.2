// ============================================================
// POST /api/gmail-disconnect
// Deletes the stored refresh token server-side. Does not revoke
// Google's own consent grant — if you want this app fully off your
// Google account, also remove it at myaccount.google.com/permissions.
// ============================================================
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'server not configured' });
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/gmail_tokens?id=eq.default', {
      method: 'DELETE',
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY },
    });
    if (!r.ok) return res.status(500).json({ error: 'failed to delete token: ' + (await r.text()) });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
}
