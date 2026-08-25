// ============================================================
// POST /api/scan-gmail-orders
// The actual worker: pulls the stored refresh token (service-role
// only, never client-visible), searches Gmail for likely shipping/
// order emails, asks Claude to classify + extract structured order
// info from each new one, and appends any real orders it finds into
// the same 'incoming_orders' list the Orders tab already reads —
// so they show up exactly like a manually-typed order would.
//
// Called two ways:
//   - A cron (cron-job.org, every 15-30 min) for hands-off scanning.
//   - The "Scan now" button in finance.html for on-demand runs.
// Neither needs a secret: this endpoint returns no confidential data
// (never the token, never raw email content), so the only real risk
// is cost/abuse — mitigated by MIN_SCAN_INTERVAL_MINUTES below.
//
// Env vars required on Vercel:
//   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
//   ANTHROPIC_API_KEY
// ============================================================

const MIN_SCAN_INTERVAL_MINUTES = 10;
const MAX_MESSAGES_PER_RUN = 15;
const SEARCH_QUERY = '(shipped OR shipping OR "tracking number" OR "your order" OR "order confirmed" OR "order confirmation" OR dispatched OR "out for delivery" OR delivery) newer_than:21d -in:spam -in:trash';

async function supaService(path, options) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return fetch(url + '/rest/v1/' + path, {
    ...options,
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...(options && options.headers) },
  });
}
async function supaAnon(path, options) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  return fetch(url + '/rest/v1/' + path, {
    ...options,
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...(options && options.headers) },
  });
}

function b64urlDecode(data) {
  try { return Buffer.from(String(data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'); }
  catch (e) { return ''; }
}

function extractPlainText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) return b64urlDecode(payload.body.data);
  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      const found = extractPlainText(part);
      if (found) return found;
    }
    // No text/plain anywhere — fall back to text/html, stripped.
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body && part.body.data) {
        return b64urlDecode(part.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      }
    }
  }
  if (payload.mimeType === 'text/html' && payload.body && payload.body.data) {
    return b64urlDecode(payload.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  }
  return '';
}

async function claudeExtractOrder(subject, from, bodyText) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not configured');
  const prompt =
    'You are filtering an inbox for package/order shipping confirmations. ' +
    'Given this email, decide if it is a genuine order confirmation, shipping notice, or delivery update for a physical package (not a newsletter, ad, receipt for a subscription/service, or unrelated email).\n\n' +
    'Subject: ' + subject + '\nFrom: ' + from + '\nBody (truncated):\n' + bodyText.slice(0, 4000) +
    '\n\nRespond with ONLY strict JSON, no prose, no markdown fences. If it is NOT a package order/shipping email: {"isOrder": false}. ' +
    'If it IS one: {"isOrder": true, "item": "short item/order name", "cost": number or null, "currency": "3-letter code or null", "carrier": "string or null", "trackingNumber": "string or null", "expectedDate": "YYYY-MM-DD or null"}.';

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!r.ok) throw new Error('Anthropic API error: ' + (await r.text()));
  const json = await r.json();
  const text = (json.content && json.content[0] && json.content[0].text) || '{"isOrder": false}';
  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
  try { return JSON.parse(cleaned); } catch (e) { return { isOrder: false }; }
}

let cachedRates = null;
async function chfAmount(amount, currency) {
  if (amount == null) return null;
  const ccy = (currency || 'CHF').toUpperCase();
  if (ccy === 'CHF') return amount;
  try {
    if (!cachedRates) {
      const r = await fetch('https://open.er-api.com/v6/latest/CHF');
      const j = await r.json();
      cachedRates = (j && j.rates) || {};
    }
    const rate = cachedRates[ccy];
    return rate ? amount / rate : amount;
  } catch (e) {
    return amount;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  if (!SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: 'server not configured (missing Supabase env vars)' });
  }
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) return res.status(500).json({ error: 'server not configured (missing GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET)' });

  try {
    // --- load stored refresh token + throttle ---------------------------
    const tokRes = await supaService('gmail_tokens?id=eq.default&select=refresh_token,last_scanned_at', { method: 'GET' });
    if (!tokRes.ok) return res.status(500).json({ error: 'failed to read gmail_tokens: ' + (await tokRes.text()) });
    const tokRows = await tokRes.json();
    if (!tokRows.length) return res.status(200).json({ ok: true, connected: false, note: 'Gmail not connected' });
    const { refresh_token: refreshToken, last_scanned_at: lastScannedAt } = tokRows[0];

    if (lastScannedAt) {
      const minsSince = (Date.now() - new Date(lastScannedAt).getTime()) / 60000;
      if (minsSince < MIN_SCAN_INTERVAL_MINUTES) {
        return res.status(200).json({ ok: true, skipped: true, note: 'scanned ' + Math.round(minsSince) + ' min ago, minimum interval is ' + MIN_SCAN_INTERVAL_MINUTES + ' min' });
      }
    }

    // --- refresh the Gmail access token ----------------------------------
    const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
    });
    if (!refreshRes.ok) return res.status(500).json({ error: 'Gmail token refresh failed: ' + (await refreshRes.text()) });
    const { access_token: accessToken } = await refreshRes.json();
    if (!accessToken) return res.status(500).json({ error: 'no access_token from Gmail refresh' });

    // Mark scan time immediately, even if something below fails — avoids a
    // broken cron hammering Gmail/Anthropic every run.
    await supaService('gmail_tokens?id=eq.default', {
      method: 'PATCH',
      body: JSON.stringify({ last_scanned_at: new Date().toISOString() }),
    });

    // --- list candidate messages ------------------------------------------
    const listUrl = 'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=' + MAX_MESSAGES_PER_RUN + '&q=' + encodeURIComponent(SEARCH_QUERY);
    const listRes = await fetch(listUrl, { headers: { Authorization: 'Bearer ' + accessToken } });
    if (!listRes.ok) return res.status(500).json({ error: 'Gmail list failed: ' + (await listRes.text()) });
    const listJson = await listRes.json();
    const candidates = listJson.messages || [];
    if (!candidates.length) return res.status(200).json({ ok: true, connected: true, candidatesFound: 0, scanned: 0, ordersAdded: 0 });

    // --- skip already-processed messages -----------------------------------
    const idsParam = candidates.map((m) => encodeURIComponent(m.id)).join(',');
    const processedRes = await supaService('gmail_processed?message_id=in.(' + idsParam + ')&select=message_id', { method: 'GET' });
    const processedSet = new Set(processedRes.ok ? (await processedRes.json()).map((r) => r.message_id) : []);
    const toCheck = candidates.filter((m) => !processedSet.has(m.id));

    const newOrders = [];
    let scannedCount = 0;
    let classifiedAsOrderCount = 0;

    for (const m of toCheck) {
      scannedCount++;
      try {
        const msgRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/' + m.id + '?format=full', {
          headers: { Authorization: 'Bearer ' + accessToken },
        });
        if (!msgRes.ok) continue;
        const msg = await msgRes.json();
        const headers = (msg.payload && msg.payload.headers) || [];
        const subject = (headers.find((h) => h.name === 'Subject') || {}).value || '';
        const from = (headers.find((h) => h.name === 'From') || {}).value || '';
        let bodyText = extractPlainText(msg.payload);
        if (!bodyText) bodyText = msg.snippet || '';

        const result = await claudeExtractOrder(subject, from, bodyText);
        if (result && result.isOrder) {
          classifiedAsOrderCount++;
          const amountCHF = await chfAmount(typeof result.cost === 'number' ? result.cost : null, result.currency);
          newOrders.push({
            id: 'o_gmail_' + m.id,
            name: result.item || subject || 'Package',
            amount: amountCHF != null ? amountCHF : 0,
            entered_amount: typeof result.cost === 'number' ? result.cost : (amountCHF || 0),
            entered_currency: (result.currency || 'CHF').toUpperCase(),
            fromCat: 'bank',
            fromAccount: null,
            date: result.expectedDate || null,
            ts: Date.now(),
            deductedAt: null,
            pctAtDeduction: null,
            deductedFrom: null,
            source: 'gmail',
            carrier: result.carrier || null,
            trackingNumber: result.trackingNumber || null,
          });
        }
      } catch (e) {
        // One bad message shouldn't kill the whole run.
      } finally {
        await supaService('gmail_processed', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify({ message_id: m.id }),
        }).catch(() => {});
      }
    }

    // --- merge any new orders into finance's incoming_orders --------------
    if (newOrders.length) {
      const financeRes = await supaAnon('app_state?key=eq.finance&select=data', { method: 'GET' });
      const financeRows = financeRes.ok ? await financeRes.json() : [];
      const currentData = (financeRows[0] && financeRows[0].data) || {};
      const existingOrders = Array.isArray(currentData.incoming_orders) ? currentData.incoming_orders : [];
      const existingIds = new Set(existingOrders.map((o) => o.id));
      const toAdd = newOrders.filter((o) => !existingIds.has(o.id));
      if (toAdd.length) {
        const mergedData = { ...currentData, incoming_orders: existingOrders.concat(toAdd) };
        await supaAnon('app_state?key=eq.finance', {
          method: 'PATCH',
          body: JSON.stringify({ data: mergedData, updated_at: new Date().toISOString() }),
        });
      }
    }

    return res.status(200).json({
      ok: true, connected: true,
      candidatesFound: candidates.length,
      alreadyProcessed: candidates.length - toCheck.length,
      scanned: scannedCount,
      classifiedAsOrder: classifiedAsOrderCount,
      ordersAdded: newOrders.length,
    });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
}
