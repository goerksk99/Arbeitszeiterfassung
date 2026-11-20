begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create type public.app_role as enum ('admin', 'employee');
create type public.entry_status as enum ('open', 'recorded', 'submitted', 'approved', 'rejected');
create type public.absence_type as enum ('vacation', 'sick', 'comp_time', 'other');
create type public.absence_status as enum ('submitted', 'approved', 'rejected');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  full_name text not null check (btrim(full_name) <> ''),
  role public.app_role not null default 'employee',
  weekly_hours numeric(5,2) not null default 40 check (weekly_hours between 0 and 168),
  annual_leave_days numeric(5,2) not null default 30 check (annual_leave_days between 0 and 366),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.company_settings (
  id smallint primary key default 1 check (id = 1),
  auto_break_start time not null default '12:00' check (auto_break_start < time '24:00'),
  auto_break_minutes integer not null default 30 check (auto_break_minutes between 0 and 1440)
);
insert into public.company_settings default values;

create table public.time_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  started_at timestamptz not null check (isfinite(started_at)),
  ended_at timestamptz check (isfinite(ended_at)),
  break_minutes integer not null default 0 check (break_minutes >= 0),
  break_adjusted boolean not null default false,
  note text,
  status public.entry_status not null default 'open',
  correction_reason text,
  corrects_entry_id uuid references public.time_entries(id),
  approved_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  check (corrects_entry_id is null or (corrects_entry_id <> id and status in ('submitted', 'approved', 'rejected'))),
  check ((status = 'open') = (ended_at is null)),
  check (ended_at is null or (ended_at > started_at and
    break_minutes * interval '1 minute' <= ended_at - started_at)),
  check (status <> 'submitted' or nullif(btrim(correction_reason), '') is not null)
);
create unique index time_entries_one_open on public.time_entries (user_id) where status = 'open';
create unique index time_entries_one_pending_correction on public.time_entries (corrects_entry_id)
where status = 'submitted' and corrects_entry_id is not null;
create index time_entries_user_start on public.time_entries (user_id, started_at);

create table public.absences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  type public.absence_type not null,
  start_date date not null check (isfinite(start_date)),
  end_date date not null check (isfinite(end_date) and end_date >= start_date),
  status public.absence_status not null default 'submitted',
  note text,
  created_at timestamptz not null default now()
);
create index absences_user_start on public.absences (user_id, start_date);

create table public.monthly_summaries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  year integer not null check (year between 1 and 9999),
  month integer not null check (month between 1 and 12),
  target_minutes integer not null default 0 check (target_minutes >= 0),
  worked_minutes integer not null default 0 check (worked_minutes >= 0),
  break_minutes integer not null default 0 check (break_minutes >= 0),
  balance_minutes integer not null default 0,
  carryover_minutes integer not null default 0,
  vacation_days integer not null default 0 check (vacation_days >= 0),
  sick_days integer not null default 0 check (sick_days >= 0),
  comp_time_days integer not null default 0 check (comp_time_days >= 0),
  is_locked boolean not null default false,
  closed_by uuid references public.profiles(id),
  closed_at timestamptz,
  unique (user_id, year, month),
  check (not is_locked or (closed_by is not null and closed_at is not null))
);

create function private.is_active_member() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select from public.profiles where id = auth.uid() and is_active)
$$;

create function private.is_admin() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select from public.profiles where id = auth.uid() and is_active and role = 'admin')
$$;

create function private.lock_user(owner_id uuid) returns void
language sql set search_path = ''
as $$
  select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner_id::text, 0))
$$;

create function private.assert_unlocked(owner_id uuid, first_day date, last_day date) returns void
language plpgsql set search_path = ''
as $$
begin
  if exists (
    select from public.monthly_summaries s
    where s.user_id = owner_id and s.is_locked
      and (s.year * 12 + s.month) between
        (extract(year from first_day) * 12 + extract(month from first_day)) and
        (extract(year from last_day) * 12 + extract(month from last_day))
  ) then
    raise exception 'Der Monat ist bereits abgeschlossen.' using errcode = '42501';
  end if;
end
$$;

create function private.automatic_break(
  started timestamptz, ended timestamptz, pause_start time, pause_minutes integer
) returns integer language sql stable set search_path = ''
as $$
  select (count(*) * pause_minutes)::integer
  from pg_catalog.generate_series(
    0, (ended at time zone 'Europe/Berlin')::date - (started at time zone 'Europe/Berlin')::date
  ) as days(offset_days)
  cross join lateral (
    select (((started at time zone 'Europe/Berlin')::date + days.offset_days) + pause_start)
      at time zone 'Europe/Berlin' as begins
  ) as pause
  where started < pause.begins and ended > pause.begins + make_interval(mins => pause_minutes)
$$;

create function private.guard_time_entry() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  settings public.company_settings%rowtype;
  original public.time_entries%rowtype;
begin
  perform private.lock_user(case when tg_op = 'DELETE' then old.user_id else new.user_id end);
  if tg_op = 'DELETE' then return old; end if;
  if auth.uid() is null or private.is_admin() then
    if new.status = 'recorded' and not new.break_adjusted then
      select * into strict settings from public.company_settings where id = 1;
      new.break_minutes := private.automatic_break(
        new.started_at, new.ended_at, settings.auto_break_start, settings.auto_break_minutes);
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.id <> old.id or new.user_id <> old.user_id or new.created_at <> old.created_at
      or new.corrects_entry_id is distinct from old.corrects_entry_id then
      raise exception 'Geschützte Buchungsfelder.' using errcode = '42501';
    end if;
    perform private.assert_unlocked(old.user_id, (old.started_at at time zone 'Europe/Berlin')::date,
      (coalesce(old.ended_at, old.started_at) at time zone 'Europe/Berlin')::date);
  else
    new.created_at := statement_timestamp();
  end if;

  if new.approved_by is not null then
    raise exception 'Freigaben erfordern Adminrechte.' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' and new.status = 'open' then
    new.started_at := clock_timestamp();
    new.ended_at := null;
    new.break_minutes := 0;
    new.break_adjusted := false;
  elsif tg_op = 'UPDATE' and old.status = 'open' and new.status = 'recorded' then
    new.started_at := old.started_at;
    new.ended_at := clock_timestamp();
  elsif new.status <> 'submitted' or (tg_op = 'UPDATE' and old.status <> 'submitted') then
    raise exception 'Historische Zeiten erfordern einen Korrekturantrag.' using errcode = '42501';
  end if;

  if new.corrects_entry_id is not null then
    select * into original from public.time_entries
    where id = new.corrects_entry_id and user_id = new.user_id
      and status in ('open', 'recorded', 'approved');
    if not found then
      raise exception 'Ungültiger Bezug für den Korrekturantrag.' using errcode = '42501';
    end if;
    perform private.assert_unlocked(original.user_id, (original.started_at at time zone 'Europe/Berlin')::date,
      (coalesce(original.ended_at, original.started_at) at time zone 'Europe/Berlin')::date);
  end if;

  if new.ended_at is not null and not new.break_adjusted then
    select * into strict settings from public.company_settings where id = 1;
    new.break_minutes := private.automatic_break(
      new.started_at, new.ended_at, settings.auto_break_start, settings.auto_break_minutes);
  end if;

  perform private.assert_unlocked(new.user_id, (new.started_at at time zone 'Europe/Berlin')::date,
    (coalesce(new.ended_at, new.started_at) at time zone 'Europe/Berlin')::date);
  return new;
end
$$;

create function private.guard_absence() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.lock_user(case when tg_op = 'DELETE' then old.user_id else new.user_id end);
  if tg_op <> 'DELETE' and new.status = 'approved' and exists (
    select from public.absences a
    where a.user_id = new.user_id and a.id <> new.id and a.status = 'approved'
      and a.start_date <= new.end_date and a.end_date >= new.start_date
  ) then
    raise exception 'Genehmigte Abwesenheiten überschneiden sich.' using errcode = '23P01';
  end if;

  if auth.uid() is null or private.is_admin() then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op <> 'INSERT' then
    perform private.assert_unlocked(old.user_id, old.start_date, old.end_date);
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if tg_op = 'UPDATE' and
    (new.id <> old.id or new.user_id <> old.user_id or new.created_at <> old.created_at) then
    raise exception 'Geschützte Abwesenheitsfelder.' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then new.created_at := statement_timestamp(); end if;
  perform private.assert_unlocked(new.user_id, new.start_date, new.end_date);
  return new;
end
$$;

create function private.guard_summary() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.lock_user(case when tg_op = 'DELETE' then old.user_id else new.user_id end);
  if tg_op = 'DELETE' then return old; end if;
  if tg_op = 'UPDATE' and (new.user_id, new.year, new.month) <> (old.user_id, old.year, old.month) then
    raise exception 'Der Schlüssel eines Monatsabschlusses ist fest.';
  end if;
  return new;
end
$$;

create trigger guard_time_entry before insert or update or delete on public.time_entries
for each row execute function private.guard_time_entry();
create trigger guard_absence before insert or update or delete on public.absences
for each row execute function private.guard_absence();
create trigger guard_summary before insert or update or delete on public.monthly_summaries
for each row execute function private.guard_summary();

alter table public.profiles enable row level security;
alter table public.company_settings enable row level security;
alter table public.time_entries enable row level security;
alter table public.absences enable row level security;
alter table public.monthly_summaries enable row level security;

create policy profiles_admin on public.profiles for all to authenticated
using (private.is_admin()) with check (private.is_admin());
create policy profiles_own on public.profiles for select to authenticated
using (id = auth.uid() and is_active);

create policy settings_admin on public.company_settings for update to authenticated
using (private.is_admin()) with check (private.is_admin());
create policy settings_read on public.company_settings for select to authenticated
using (private.is_active_member());

create policy entries_admin on public.time_entries for all to authenticated
using (private.is_admin()) with check (private.is_admin());
create policy entries_own on public.time_entries for select to authenticated
using (user_id = auth.uid() and private.is_active_member());
create policy entries_insert on public.time_entries for insert to authenticated
with check (user_id = auth.uid() and private.is_active_member() and status in ('open', 'submitted'));
create policy entries_update on public.time_entries for update to authenticated
using (user_id = auth.uid() and private.is_active_member() and status in ('open', 'submitted'))
with check (user_id = auth.uid() and private.is_active_member() and status in ('recorded', 'submitted'));

create policy absences_admin on public.absences for all to authenticated
using (private.is_admin()) with check (private.is_admin());
create policy absences_own on public.absences for select to authenticated
using (user_id = auth.uid() and private.is_active_member());
create policy absences_insert on public.absences for insert to authenticated
with check (user_id = auth.uid() and private.is_active_member() and status = 'submitted');
create policy absences_update on public.absences for update to authenticated
using (user_id = auth.uid() and private.is_active_member() and status = 'submitted')
with check (user_id = auth.uid() and private.is_active_member() and status = 'submitted');
create policy absences_delete on public.absences for delete to authenticated
using (user_id = auth.uid() and private.is_active_member() and status = 'submitted');

create policy summaries_admin on public.monthly_summaries for all to authenticated
using (private.is_admin()) with check (private.is_admin());
create policy summaries_own on public.monthly_summaries for select to authenticated
using (user_id = auth.uid() and private.is_active_member());

-- Kalenderdaten enthalten bewusst keine internen Notizen.
create function public.team_calendar(first_day date, last_day date)
returns table (
  id uuid, user_id uuid, full_name text, type public.absence_type,
  start_date date, end_date date, status public.absence_status
)
language sql stable security definer set search_path = ''
as $$
  select a.id, a.user_id, p.full_name, a.type, a.start_date, a.end_date, a.status
  from public.absences a join public.profiles p on p.id = a.user_id
  where first_day <= last_day and a.start_date <= last_day and a.end_date >= first_day
    and private.is_active_member()
    and (private.is_admin() or a.user_id = auth.uid() or
      (a.status = 'approved' and a.type <> 'sick'))
$$;

revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.is_active_member(), private.is_admin() to authenticated;
revoke all on function public.team_calendar(date, date) from public, anon, authenticated;
grant execute on function public.team_calendar(date, date) to authenticated;

revoke all on public.profiles, public.company_settings, public.time_entries, public.absences,
  public.monthly_summaries from public, anon, authenticated;
grant select, insert, update, delete on public.profiles, public.time_entries, public.absences,
  public.monthly_summaries to authenticated;
grant select, update on public.company_settings to authenticated;

commit;
