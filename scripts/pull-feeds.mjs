/* Pulls shifts from calendar feeds the browser cannot read (Google blocks
   cross-origin reads) and writes them into the shared Supabase row.

   Block ids match the ones the browser builds, so this and the app agree and a
   run with no upstream change is a no-op rather than churn.

   Env:
     SUPABASE_URL, SUPABASE_KEY, ROOM_CODE
     FEEDS  JSON: [{"url":"...","person":"a|b","kind":"rso","label":"RSO"}]
     TZ_NAME  optional, defaults to America/New_York
*/
const { SUPABASE_URL, SUPABASE_KEY, ROOM_CODE, FEEDS } = process.env;
const TZ = process.env.TZ_NAME || "America/New_York";

for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_KEY, ROOM_CODE, FEEDS })) {
  if (!v) { console.error(`Missing ${k}`); process.exit(1); }
}

const hash32 = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };
const pad = n => String(n).padStart(2, "0");
const iso = ({ y, mo, d }) => `${y}-${pad(mo)}-${pad(d)}`;

/* Sunday that starts the week containing this date. */
function weekStart(p) {
  const dt = new Date(Date.UTC(p.y, p.mo - 1, p.d));
  const back = dt.getUTCDay();
  dt.setUTCDate(dt.getUTCDate() - back);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}
const dayIndex = p => new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay();

/* A UTC instant rendered in the calendar's own timezone. Floating and TZID
   values are already local, so their digits are used as written. */
function toLocalParts(date, tz) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz || TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  });
  const p = Object.fromEntries(f.formatToParts(date).map(x => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute };
}
function icsParts(val, tz) {
  const m = val.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined) return { y: +y, mo: +mo, d: +d, h: 0, mi: 0, allDay: true };
  if (z) return toLocalParts(new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)), tz);
  return { y: +y, mo: +mo, d: +d, h: +h, mi: +mi };
}
const minsOf = p => p.h * 60 + p.mi;
const stamp = p => Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);

/* Read the timezone the feed declares rather than assuming one. If the calendar
   is set correctly this is a no-op; if it is set to another zone (WhenToWork
   writes shift times into whatever zone the Google calendar uses, so an account
   left on Asia/Kolkata records a Boston 8am shift as 8am IST) this recovers the
   wall-clock time actually intended. Either way the label and the block agree. */
function feedTimezone(text) {
  const m = text.match(/^X-WR-TIMEZONE:(.+)$/mi);
  if (!m) return null;
  const tz = m[1].trim();
  try { new Intl.DateTimeFormat("en-CA", { timeZone: tz }); return tz; } catch { return null; }
}
function parseICS(text) {
  const tz = feedTimezone(text) || TZ;
  const out = [];
  let cur = null;
  for (const raw of text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n")) {
    const t = raw.trim();
    if (t === "BEGIN:VEVENT") { cur = {}; continue; }
    if (t === "END:VEVENT") { if (cur?.start && cur?.end) out.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = t.indexOf(":");
    if (i < 0) continue;
    const name = t.slice(0, i).split(";")[0].toUpperCase();
    const val = t.slice(i + 1);
    if (name === "DTSTART") cur.start = icsParts(val, tz);
    else if (name === "DTEND") cur.end = icsParts(val, tz);
    else if (name === "SUMMARY") cur.summary = val.replace(/\\n/gi, ", ").replace(/\\,/g, ",").replace(/\\;/g, ";").trim();
    else if (name === "UID") cur.uid = val.trim();
    else if (name === "STATUS") cur.status = val.trim().toUpperCase();
  }
  out.tz = tz;
  return out;
}

/* One event becomes one block per calendar day it touches. */
function blocksFor(feed, feedId, ev) {
  const out = [];
  if (ev.status === "CANCELLED" || ev.allDay) return out;
  if (stamp(ev.end) <= stamp(ev.start)) return out;
  // WhenToWork appends the time to the title; the block already shows it.
  const title = (ev.summary || feed.label || "Shift")
    .replace(/\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)\s*-\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)\s*$/i, "")
    .trim().slice(0, 60) || feed.label || "Shift";

  let cur = { ...ev.start };
  for (let guard = 0; guard < 8; guard++) {
    const sameDay = cur.y === ev.end.y && cur.mo === ev.end.mo && cur.d === ev.end.d;
    const startMin = minsOf(cur);
    const endMin = sameDay ? minsOf(ev.end) : 1440;
    if (endMin > startMin) {
      const week = weekStart(cur);
      out.push({
        id: "f" + feedId + "_" + hash32((ev.uid || title) + "|" + week + "|" + startMin),
        person: feed.person, day: dayIndex(cur), start: startMin, end: endMin,
        title, kind: feed.kind, week, src: feedId
      });
    }
    if (sameDay) break;
    const next = new Date(Date.UTC(cur.y, cur.mo - 1, cur.d + 1));
    cur = { y: next.getUTCFullYear(), mo: next.getUTCMonth() + 1, d: next.getUTCDate(), h: 0, mi: 0 };
  }
  return out;
}

const head = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" };
const base = `${SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/schedules`;

const res = await fetch(`${base}?id=eq.${encodeURIComponent(ROOM_CODE)}&select=data`, { headers: head });
if (!res.ok) { console.error("Supabase read failed:", res.status, await res.text()); process.exit(1); }
const rows = await res.json();
const data = rows[0]?.data ?? { v: 4, events: [], tomb: [], feeds: [] };
data.events ||= []; data.tomb ||= []; data.feeds ||= [];

const today = new Date();
const loMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 21);
const hiMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 84);

const now = Date.now();
let added = 0, removed = 0, changed = 0, failed = 0;

for (const feed of JSON.parse(FEEDS)) {
  const feedId = hash32(feed.url).slice(0, 8);
  let want = new Map();
  try {
    const r = await fetch(feed.url, { headers: { "User-Agent": "schedule-sync" } });
    if (!r.ok) throw new Error("feed replied " + r.status);
    const text = await r.text();
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("not a calendar feed");
    for (const ev of parseICS(text)) {
      const at = stamp(ev.start);
      if (at < loMs || at > hiMs) continue;
      for (const b of blocksFor(feed, feedId, ev)) want.set(b.id, b);
    }
  } catch (err) {
    // Never delete shifts because a fetch failed; leave what is there and move on.
    console.error(`feed ${feed.label || feedId} failed: ${err.message}`);
    failed++;
    continue;
  }

  /* A feed that suddenly returns nothing is almost always a glitch upstream, not
     every shift being cancelled at once. Deleting on that signal loses real data,
     so hold what we have and report instead. */
  const held = data.events.filter(e => e.src === feedId).length;
  if (want.size === 0 && held > 0) {
    console.error(`feed ${feed.label || feedId}: returned 0 events but ${held} are held; keeping them`);
    const m0 = data.feeds.find(f => f.id === feedId);
    if (m0) { m0.err = "the calendar came back empty, so the shifts were kept"; m0.m = now; }
    failed++;
    continue;
  }

  for (const e of data.events.filter(e => e.src === feedId)) {
    const w = want.get(e.id);
    if (!w) { data.tomb.push({ k: e.id, t: now }); removed++; continue; }
    if (w.title !== e.title || w.start !== e.start || w.end !== e.end ||
        w.day !== e.day || w.person !== e.person || w.kind !== e.kind) {
      Object.assign(e, w); e.m = now; changed++;
    }
    want.delete(e.id);
  }
  if (removed) {
    const gone = new Set(data.tomb.filter(t => t.t === now).map(t => t.k));
    data.events = data.events.filter(e => !gone.has(e.id));
  }
  for (const b of want.values()) { b.m = now; data.events.push(b); added++; }

  const meta = data.feeds.find(f => f.id === feedId);
  const rec = { id: feedId, url: "(pulled by the scheduled job)", person: feed.person,
                kind: feed.kind, label: feed.label || "", server: true, last: now, err: "", m: now };
  if (meta) Object.assign(meta, rec); else data.feeds.push(rec);
}

if (!added && !removed && !changed) {
  console.log(`no change (${failed} feed(s) failed)`);
  process.exit(failed ? 1 : 0);
}

const put = await fetch(base, {
  method: "POST",
  headers: { ...head, Prefer: "resolution=merge-duplicates,return=minimal" },
  body: JSON.stringify([{ id: ROOM_CODE, data, updated_at: new Date().toISOString() }])
});
if (!put.ok) { console.error("Supabase write failed:", put.status, await put.text()); process.exit(1); }
console.log(`added ${added}, removed ${removed}, changed ${changed}, failed ${failed}`);
process.exit(failed ? 1 : 0);
