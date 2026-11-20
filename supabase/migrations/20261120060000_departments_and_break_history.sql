begin;

alter table public.profiles add column automatic_lunch_break boolean not null default true;

create table private.clock_break_intervals (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.time_entries(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz check (ended_at >= started_at)
);
create unique index one_running_clock_break_interval on private.clock_break_intervals(entry_id) where ended_at is null;
revoke all on private.clock_break_intervals from public, anon, authenticated;

insert into private.clock_break_intervals (entry_id, started_at)
select b.entry_id, b.paused_at from private.clock_breaks b
join public.time_entries e on e.id=b.entry_id
where b.paused_at is not null and e.status='open';

create function private.capture_clock_break_interval() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.paused_at is not null and new.paused_at is null then
    update private.clock_break_intervals b
    set ended_at = greatest(b.started_at, clock_timestamp())
    where b.entry_id = new.entry_id and b.ended_at is null;
  elsif new.paused_at is not null and (tg_op = 'INSERT' or old.paused_at is null) then
    insert into private.clock_break_intervals (entry_id, started_at)
    values (new.entry_id, new.paused_at)
    on conflict (entry_id) where ended_at is null do nothing;
  end if;
  return new;
end
$$;
create trigger capture_clock_break_interval after insert or update on private.clock_breaks
for each row execute function private.capture_clock_break_interval();

create function private.finish_clock_break_after_entry() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.status = 'open' and new.status <> 'open' then
    update private.clock_break_intervals b
    set ended_at = greatest(b.started_at, least(new.ended_at, clock_timestamp()))
    where b.entry_id = old.id and b.ended_at is null;
  end if;
  return new;
end
$$;
create trigger finish_clock_break_after_entry after update on public.time_entries
for each row execute function private.finish_clock_break_after_entry();

create function public.read_shift_breaks(member_id uuid, first_day date, last_day date)
returns table (id uuid, entry_id uuid, user_id uuid, started_at timestamptz, ended_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
declare
  first_at timestamptz := first_day::timestamp at time zone 'Europe/Berlin';
  end_at timestamptz := (last_day + 1)::timestamp at time zone 'Europe/Berlin';
begin
  if not private.is_active_member() or (member_id is distinct from auth.uid() and not private.is_admin()) then
    raise exception 'Kein Zugriff auf diese Pausenzeiten.' using errcode = '42501';
  end if;
  if last_day < first_day or last_day-first_day > 366 then
    raise exception 'Ungültiger Zeitraum.';
  end if;
  return query select b.id, b.entry_id, e.user_id, b.started_at, b.ended_at
  from private.clock_break_intervals b join public.time_entries e on e.id=b.entry_id
  where (member_id is null or member_id=e.user_id)
    and ((b.started_at < end_at and (b.ended_at is null or b.ended_at >= first_at))
      or (e.started_at >= first_at and e.started_at < end_at))
  order by b.started_at;
end
$$;

create function public.update_staff_settings(member_id uuid, member_name text, hours numeric,
  leave_days numeric, active boolean, member_department text, automatic_lunch boolean)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  perform private.assert_admin();
  perform private.lock_user(member_id);
  update public.profiles set full_name=btrim(member_name), weekly_hours=hours, annual_leave_days=leave_days,
    is_active=case when member_id=auth.uid() then true else active end,
    department=nullif(member_department,''), automatic_lunch_break=automatic_lunch
  where id=member_id;
  if not found then raise exception 'Profil nicht gefunden.' using errcode='P0002'; end if;
end
$$;

create function private.automatic_break_for_member(member_id uuid, started timestamptz, ended timestamptz,
  lunch_start time, lunch_minutes integer) returns integer
language sql stable set search_path = ''
as $$
  select case when (select p.automatic_lunch_break from public.profiles p where p.id=member_id)
    then private.automatic_break(started, ended, lunch_start, lunch_minutes) else 0 end
$$;

create or replace function private.guard_time_entry() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  settings public.company_settings%rowtype;
  original public.time_entries%rowtype;
begin
  perform private.lock_user(case when tg_op = 'DELETE' then old.user_id else new.user_id end);
  if tg_op = 'DELETE' then return old; end if;
  if auth.uid() is null or private.is_admin() then
    if new.status in ('recorded','submitted') and not new.break_adjusted then
      select * into strict settings from public.company_settings where id = 1;
      new.break_minutes := private.automatic_break_for_member(
        new.user_id, new.started_at, new.ended_at, settings.auto_break_start, settings.auto_break_minutes);
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
    new.break_minutes := private.automatic_break_for_member(
      new.user_id, new.started_at, new.ended_at, settings.auto_break_start, settings.auto_break_minutes);
  end if;

  perform private.assert_unlocked(new.user_id, (new.started_at at time zone 'Europe/Berlin')::date,
    (coalesce(new.ended_at, new.started_at) at time zone 'Europe/Berlin')::date);
  return new;
end
$$;

create or replace function public.resolve_open_entry(entry_id uuid, corrected_end timestamptz, reason text,
  adjusted_break integer default null) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  original public.time_entries%rowtype;
  settings public.company_settings%rowtype;
  proposal_id uuid;
begin
  perform private.assert_admin();
  select * into original from public.time_entries where id = entry_id;
  if not found then raise exception 'Buchung nicht gefunden.' using errcode = 'P0002'; end if;
  perform private.lock_user(original.user_id);
  select * into original from public.time_entries where id = entry_id and status = 'open' for update;
  if not found then raise exception 'Die Buchung wurde bereits geschlossen.' using errcode = 'P0002'; end if;
  select * into strict settings from public.company_settings where id = 1;
  insert into public.time_entries (user_id, started_at, ended_at, break_minutes, break_adjusted, note,
    status, correction_reason, corrects_entry_id)
  values (original.user_id, original.started_at, corrected_end,
    coalesce(adjusted_break, private.automatic_break_for_member(original.user_id, original.started_at, corrected_end,
      settings.auto_break_start, settings.auto_break_minutes)), adjusted_break is not null, original.note,
    'submitted', reason, original.id)
  returning id into proposal_id;
  perform public.review_correction(proposal_id, true);
end
$$;

revoke all on function private.capture_clock_break_interval(), private.finish_clock_break_after_entry(),
  private.automatic_break_for_member(uuid,timestamptz,timestamptz,time,integer) from public, anon, authenticated;
revoke all on function public.read_shift_breaks(uuid,date,date),
  public.update_staff_settings(uuid,text,numeric,numeric,boolean,text,boolean) from public, anon;
grant execute on function public.read_shift_breaks(uuid,date,date),
  public.update_staff_settings(uuid,text,numeric,numeric,boolean,text,boolean) to authenticated;

create function public.read_member_annual_leave(member_id uuid, report_year integer)
returns numeric language sql stable security definer set search_path = ''
as $$
  select p.annual_leave_days - (
    select count(*)
    from public.absences a
    cross join lateral generate_series(0,
      least(a.end_date, make_date(report_year,12,31)) - greatest(a.start_date, make_date(report_year,1,1))
    ) days(offset_days)
    cross join lateral (select greatest(a.start_date, make_date(report_year,1,1)) + days.offset_days as day) d
    where a.user_id=p.id and a.status='approved' and a.type='vacation'
      and a.start_date <= make_date(report_year,12,31) and a.end_date >= make_date(report_year,1,1)
      and extract(isodow from d.day)<=5 and private.german_holiday(d.day) is null
  )
  from public.profiles p where p.id=member_id and private.is_active_member() and (member_id=auth.uid() or private.is_admin())
$$;

revoke all on function public.read_member_annual_leave(uuid,integer) from public, anon;
grant execute on function public.read_member_annual_leave(uuid,integer) to authenticated;

commit;
