# Schedule Sync

A shared calendar for two people's shifts that finds the hours you're both free.
It runs in the browser as a single HTML file, with no build step and no account.

**Open it:** https://abhimanyududeja.github.io/schedule-sync/

## What it does

- **Week view**: both people's shifts side by side, with the free time you share shaded in.
  Drag to move or resize; tap empty space to add a shift.
- **Free Together**: every window you're both awake and free, exportable to your calendar.
- **Hours**: hours per job each week, a 20h on-campus meter for student visas, a weekly
  minimum for a job if it asks for one, and warnings when a new shift would go over 20h
  or an overnight runs into a morning class.
- **Pay**: each paycheck on its real payday, before and after tax, which job it's from,
  payslip amounts you type in, a month-by-month table, tax held back for the year, and a CSV export.
- **Photo / Paste**: read a schedule from a screenshot or pasted text.
- **Job calendars**: subscribe to a shift scheduler's iCal link and shifts appear by themselves.

## Sharing with your partner

Open **Settings → Start a shared calendar**, copy the invite link and send it to the one
person you share with. Changes show up on both devices within a few seconds.

Each shared calendar is stored under a long random room code. The database only ever
returns the room whose code a request carries, so one calendar can't read another.
Anyone who has your invite link can see and edit your calendar, so share it with your
partner only.

## Using your own Supabase project

Prefer to keep your data in your own database? Create a free Supabase project, run this in
its SQL editor, then use **Settings → Use your own Supabase project instead**.

```sql
create table public.schedules (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.schedules enable row level security;
create policy room_read on public.schedules for select to anon, authenticated
  using (id = current_setting('request.headers', true)::json->>'x-room');
create policy room_add on public.schedules for insert to anon, authenticated
  with check (id = current_setting('request.headers', true)::json->>'x-room');
create policy room_edit on public.schedules for update to anon, authenticated
  using (id = current_setting('request.headers', true)::json->>'x-room')
  with check (id = current_setting('request.headers', true)::json->>'x-room');
```
