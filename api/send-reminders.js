// ============================================================
// POST /api/send-reminders
// Called every few minutes by a GitHub Actions cron (see
// .github/workflows/habit-reminders.yml) with:
//   Authorization: Bearer <CRON_SECRET>
//
// For each habit with reminders on, checks whether "now" (in the
// user's own saved timezone) has just passed its reminderTime and
// it isn't already done today — if so, sends a Web Push notification
// to every subscribed device, and records the send in reminder_log
// so it isn't repeated on the next run.
//
// Env vars required (Vercel → Settings → Environment Variables):
//   SUPABASE_URL, SUPABASE_ANON_KEY  — same ones the rest of the app uses
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
//   CRON_SECRET
// ============================================================
import webpush from 'web-push';

// A habit is "due" if now is at or after its reminder time, within
// this many minutes — absorbs drift in the cron's own schedule
// (GitHub's free scheduler isn't minute-precise) without silently
// skipping a reminder whose exact minute the cron run missed.
const DUE_WINDOW_MINUTES = 15;

function todayInTz(tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}
function nowMinutesInTz(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
    const h = Number(parts.find((p) => p.type === 'hour').value);
    const m = Number(parts.find((p) => p.type === 'minute').value);
    return h * 60 + m;
  } catch (e) {
    const d = new Date();
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
}
function timeToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

async function supaFetch(url, key, path, options) {
  const r = await fetch(url + '/rest/v1/' + path, {
    ...options,
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      ...(options && options.headers ? options.headers : {}),
    },
  });
  return r;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  if (!cronSecret || auth !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
  const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
  const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
  const VAPID_SUBJECT = process.env.VAPID_SUBJECT;
  if (!SUPABASE_URL || !SUPABASE_KEY || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
    return res.status(500).json({ error: 'server not configured — missing env vars' });
  }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  try {
    // --- load habits state -------------------------------------------
    const habitsResp = await supaFetch(SUPABASE_URL, SUPABASE_KEY, 'app_state?key=eq.habits&select=data', { method: 'GET' });
    if (!habitsResp.ok) return res.status(500).json({ error: 'failed to read habits: ' + (await habitsResp.text()) });
    const habitsRows = await habitsResp.json();
    const habitsState = (habitsRows[0] && habitsRows[0].data && habitsRows[0].data.habits_v1) || null;
    if (!habitsState || !Array.isArray(habitsState.habits)) {
      return res.status(200).json({ ok: true, due: 0, sent: 0, note: 'no habits data yet' });
    }

    const tz = habitsState.timezone || 'UTC';
    const today = todayInTz(tz);
    const nowMin = nowMinutesInTz(tz);
    const log = habitsState.log || {};
    const deletedIds = habitsState.deletedIds || {};

    const dueHabits = habitsState.habits.filter((h) => {
      if (!h || deletedIds[h.id]) return false;
      if (!h.reminderEnabled || !h.reminderTime) return false;
      const doneToday = !!(log[h.id] && log[h.id][today]);
      if (doneToday) return false;
      const reminderMin = timeToMinutes(h.reminderTime);
      if (reminderMin == null) return false;
      const delta = nowMin - reminderMin;
      return delta >= 0 && delta < DUE_WINDOW_MINUTES;
    });

    if (!dueHabits.length) {
      return res.status(200).json({ ok: true, due: 0, sent: 0 });
    }

    // --- filter out habits already reminded today ---------------------
    const logCheck = await supaFetch(
      SUPABASE_URL, SUPABASE_KEY,
      'reminder_log?select=habit_id,date&date=eq.' + encodeURIComponent(today) +
        '&habit_id=in.(' + dueHabits.map((h) => encodeURIComponent(h.id)).join(',') + ')',
      { method: 'GET' }
    );
    const alreadySent = new Set();
    if (logCheck.ok) {
      const rows = await logCheck.json();
      rows.forEach((r) => alreadySent.add(r.habit_id));
    }
    const toSend = dueHabits.filter((h) => !alreadySent.has(h.id));
    if (!toSend.length) {
      return res.status(200).json({ ok: true, due: dueHabits.length, sent: 0, note: 'all already sent today' });
    }

    // --- load subscriptions ---------------------------------------------
    const subsResp = await supaFetch(SUPABASE_URL, SUPABASE_KEY, 'push_subscriptions?select=endpoint,subscription', { method: 'GET' });
    if (!subsResp.ok) return res.status(500).json({ error: 'failed to read subscriptions: ' + (await subsResp.text()) });
    const subs = await subsResp.json();
    if (!subs.length) {
      return res.status(200).json({ ok: true, due: toSend.length, sent: 0, note: 'no push subscriptions registered' });
    }

    let sentCount = 0;
    const deadEndpoints = [];

    for (const h of toSend) {
      const payload = JSON.stringify({
        title: (h.icon ? h.icon + ' ' : '') + h.name,
        body: h.description ? h.description : "It's time — mark it done when you're there.",
        tag: 'habit-' + h.id,
        url: '/habits.html',
      });
      let anySucceeded = false;
      for (const row of subs) {
        try {
          await webpush.sendNotification(row.subscription, payload);
          anySucceeded = true;
        } catch (err) {
          if (err && (err.statusCode === 404 || err.statusCode === 410)) {
            deadEndpoints.push(row.endpoint);
          }
        }
      }
      if (anySucceeded) {
        sentCount++;
        await supaFetch(SUPABASE_URL, SUPABASE_KEY, 'reminder_log', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify({ habit_id: h.id, date: today }),
        });
      }
    }

    if (deadEndpoints.length) {
      await supaFetch(
        SUPABASE_URL, SUPABASE_KEY,
        'push_subscriptions?endpoint=in.(' + deadEndpoints.map((e) => encodeURIComponent(e)).join(',') + ')',
        { method: 'DELETE' }
      ).catch(() => {});
    }

    return res.status(200).json({ ok: true, due: toSend.length, sent: sentCount, prunedSubscriptions: deadEndpoints.length });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
}
