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
function weekdayInTz(tz) {
  try {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date());
    const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return map[wd] != null ? map[wd] : new Date().getUTCDay();
  } catch (e) {
    return new Date().getUTCDay();
  }
}
// "Today minus N days" as a Y-M-D string, computed from the tz-local
// calendar date (not raw UTC-minus-N, which can land on the wrong day
// near midnight in timezones far from UTC).
function dateKeyDaysAgoInTz(tz, daysAgo) {
  const [y, m, d] = todayInTz(tz).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() - daysAgo);
  return dt.toISOString().slice(0, 10);
}
function countDoneInWindow(log, tz, habitId, periodDays) {
  const l = log[habitId] || {};
  let count = 0;
  for (let i = 0; i < periodDays; i++) {
    if (l[dateKeyDaysAgoInTz(tz, i)]) count++;
  }
  return count;
}
function isDueBySchedule(h, tz, log) {
  const sch = h.schedule || { type: 'daily' };
  if (sch.type === 'days') {
    return Array.isArray(sch.days) && sch.days.indexOf(weekdayInTz(tz)) !== -1;
  }
  if (sch.type === 'frequency') {
    const times = sch.timesPerPeriod || 1;
    const period = sch.periodDays || 7;
    return countDoneInWindow(log, tz, h.id, period) < times;
  }
  return true;
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

    // A habit can have several independent reminder times in one day —
    // each is checked and deduped separately (reminder_log is keyed by
    // habit + date + time, not just habit + date).
    const dueEntries = [];
    habitsState.habits.forEach((h) => {
      if (!h || deletedIds[h.id]) return;
      if (!h.reminderEnabled) return;
      const times = (Array.isArray(h.reminderTimes) && h.reminderTimes.length) ? h.reminderTimes : (h.reminderTime ? [h.reminderTime] : []);
      if (!times.length) return;
      const doneToday = !!(log[h.id] && log[h.id][today]);
      if (doneToday) return;
      if (!isDueBySchedule(h, tz, log)) return;
      times.forEach((t) => {
        const reminderMin = timeToMinutes(t);
        if (reminderMin == null) return;
        const delta = nowMin - reminderMin;
        if (delta >= 0 && delta < DUE_WINDOW_MINUTES) dueEntries.push({ habit: h, time: t });
      });
    });

    if (!dueEntries.length) {
      return res.status(200).json({ ok: true, due: 0, sent: 0 });
    }

    // --- filter out (habit, time) pairs already reminded today --------
    const logCheck = await supaFetch(
      SUPABASE_URL, SUPABASE_KEY,
      'reminder_log?select=habit_id,time&date=eq.' + encodeURIComponent(today),
      { method: 'GET' }
    );
    if (!logCheck.ok) {
      // Fail closed, not open — if we can't verify what's already been
      // sent, sending anyway risks re-firing the same reminder on every
      // cron tick for the whole DUE_WINDOW_MINUTES instead of once.
      return res.status(500).json({ error: 'reminder_log read failed — has the migration in SETUP.md (adding the "time" column) been run? ' + (await logCheck.text()) });
    }
    const alreadySent = new Set();
    (await logCheck.json()).forEach((r) => alreadySent.add(r.habit_id + '|' + r.time));
    const toSend = dueEntries.filter((e) => !alreadySent.has(e.habit.id + '|' + e.time));
    if (!toSend.length) {
      return res.status(200).json({ ok: true, due: dueEntries.length, sent: 0, note: 'all already sent today' });
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

    for (const entry of toSend) {
      const h = entry.habit;
      const payload = JSON.stringify({
        title: (h.icon ? h.icon + ' ' : '') + h.name,
        body: h.description ? h.description : "It's time — mark it done when you're there.",
        tag: 'habit-' + h.id + '-' + entry.time,
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
          body: JSON.stringify({ habit_id: h.id, date: today, time: entry.time }),
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
