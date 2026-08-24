// ============================================================
// GET /api/gmail-status
// Tells the client whether Gmail is connected and when it was last
// scanned — safe to expose publicly since it reveals no secret, just
// booleans/timestamps. The refresh token itself never leaves the
// server (see gmail-callback.js).
// ============================================================
export default async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(200).json({ connected: false, configured: false });
  }
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/gmail_tokens?id=eq.default&select=updated_at,last_scanned_at', {
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY },
    });
    if (!r.ok) return res.status(200).json({ connected: false, configured: true });
    const rows = await r.json();
    if (!rows.length) return res.status(200).json({ connected: false, configured: true });
    return res.status(200).json({
      connected: true,
      configured: true,
      connectedAt: rows[0].updated_at,
      lastScannedAt: rows[0].last_scanned_at || null,
    });
  } catch (e) {
    return res.status(200).json({ connected: false, configured: true, error: e && e.message ? e.message : String(e) });
  }
}
