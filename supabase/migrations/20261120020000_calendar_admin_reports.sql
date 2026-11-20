begin;

alter table public.time_entries
  add column original_entry jsonb,
  add constraint time_entries_review_audit_check
    check (original_entry is null or (corrects_entry_id is not null and status = 'approved'));

create function private.assert_admin() returns void
language plpgsql stable set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Adminrechte erforderlich.' using errcode = '42501';
  end if;
end
$$;

create function public.review_correction(entry_id uuid, accept boolean) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  proposal public.time_entries%rowtype;
  original public.time_entries%rowtype;
begin
  perform private.assert_admin();
  select * into proposal from public.time_entries where id = entry_id;
  if not found then raise exception 'Antrag nicht gefunden.' using errcode = 'P0002'; end if;
  perform private.lock_user(proposal.user_id);
  select * into proposal from public.time_entries where id = entry_id and status = 'submitted' for update;
  if not found then raise exception 'Der Antrag wurde bereits entschieden.' using errcode = 'P0002'; end if;

  if accept then
    perform private.assert_unlocked(proposal.user_id, (proposal.started_at at time zone 'Europe/Berlin')::date,
      (proposal.ended_at at time zone 'Europe/Berlin')::date);
    if proposal.corrects_entry_id is not null then
      select * into original from public.time_entries
      where id = proposal.corrects_entry_id and user_id = proposal.user_id
        and status in ('open', 'recorded', 'approved') for update;
      if not found then raise exception 'Die ursprüngliche Buchung fehlt.' using errcode = 'P0002'; end if;
      perform private.assert_unlocked(original.user_id, (original.started_at at time zone 'Europe/Berlin')::date,
        (coalesce(original.ended_at, original.started_at) at time zone 'Europe/Berlin')::date);
      update public.time_entries
      set started_at = proposal.started_at, ended_at = proposal.ended_at,
          break_minutes = proposal.break_minutes, break_adjusted = proposal.break_adjusted,
          note = proposal.note, status = 'approved', approved_by = auth.uid()
      where id = original.id;
    end if;
  end if;

  update public.time_entries
  set status = case when accept then 'approved'::public.entry_status else 'rejected'::public.entry_status end,
      approved_by = auth.uid(),
      original_entry = case when original.id is not null then to_jsonb(original) end
  where id = entry_id;
end
$$;

create function public.resolve_open_entry(entry_id uuid, corrected_end timestamptz, reason text,
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
    coalesce(adjusted_break, private.automatic_break(original.started_at, corrected_end,
      settings.auto_break_start, settings.auto_break_minutes)), adjusted_break is not null, original.note,
    'submitted', reason, original.id)
  returning id into proposal_id;
  perform public.review_correction(proposal_id, true);
end
$$;

create function public.review_absence(absence_id uuid, accept boolean) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  request public.absences%rowtype;
begin
  perform private.assert_admin();
  select * into request from public.absences where id = absence_id;
  if not found then raise exception 'Antrag nicht gefunden.' using errcode = 'P0002'; end if;
  perform private.lock_user(request.user_id);
  select * into request from public.absences where id = absence_id and status = 'submitted' for update;
  if not found then raise exception 'Der Antrag wurde bereits entschieden.' using errcode = 'P0002'; end if;
  if accept then perform private.assert_unlocked(request.user_id, request.start_date, request.end_date); end if;
  update public.absences
  set status = case when accept then 'approved'::public.absence_status else 'rejected'::public.absence_status end
  where id = absence_id;
end
$$;

create function public.record_absence(member_id uuid, kind public.absence_type, first_day date,
  last_day date, entry_note text default null) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  absence_id uuid;
begin
  perform private.assert_admin();
  perform private.lock_user(member_id);
  perform private.assert_unlocked(member_id, first_day, last_day);
  insert into public.absences (user_id, type, start_date, end_date, status, note)
  values (member_id, kind, first_day, last_day, 'approved', nullif(btrim(entry_note), ''))
  returning id into absence_id;
  return absence_id;
end
$$;

create function private.calculate_month(member_id uuid, first_day date)
returns public.monthly_summaries
language plpgsql stable set search_path = ''
as $$
declare
  result public.monthly_summaries%rowtype;
  monthly_hours numeric;
  next_day date := (first_day + interval '1 month')::date;
  last_month date := (first_day - interval '1 month')::date;
  first_at timestamptz := first_day::timestamp at time zone 'Europe/Berlin';
  next_at timestamptz := next_day::timestamp at time zone 'Europe/Berlin';
  target_days integer;
begin
  select p.weekly_hours into monthly_hours from public.profiles p where p.id = member_id;
  if not found then raise exception 'Profil nicht gefunden.' using errcode = 'P0002'; end if;

  result.user_id := member_id;
  result.year := extract(year from first_day);
  result.month := extract(month from first_day);
  result.is_locked := false;

  select coalesce(sum(floor(extract(epoch from (e.ended_at - e.started_at)) / 60) - e.break_minutes), 0),
         coalesce(sum(e.break_minutes), 0)
  into result.worked_minutes, result.break_minutes
  from public.time_entries e
  where e.user_id = member_id and e.started_at >= first_at and e.started_at < next_at
    and e.status in ('recorded','approved') and e.corrects_entry_id is null;

  select count(*) filter (where a.type is null or a.type = 'comp_time'),
         count(*) filter (where a.type = 'vacation'),
         count(*) filter (where a.type = 'sick'),
         count(*) filter (where a.type = 'comp_time')
  into target_days, result.vacation_days, result.sick_days, result.comp_time_days
  from generate_series(0, next_day - first_day - 1) as d(day_offset)
  left join public.absences a on a.user_id = member_id and a.status = 'approved'
    and first_day + d.day_offset between a.start_date and a.end_date
  where extract(isodow from first_day + d.day_offset) <= 5;

  result.target_minutes := round(target_days * monthly_hours * 60 / 5);
  select coalesce((select s.balance_minutes from public.monthly_summaries s
    where s.user_id = member_id and s.is_locked
      and s.year = extract(year from last_month) and s.month = extract(month from last_month)), 0)
  into result.carryover_minutes;
  result.balance_minutes := result.carryover_minutes + result.worked_minutes - result.target_minutes;
  return result;
end
$$;

create function public.read_monthly_report(member_id uuid, report_year integer, report_month integer)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  first_day date := make_date(report_year, report_month, 1);
  stored public.monthly_summaries%rowtype;
begin
  if not private.is_active_member() or (member_id is distinct from auth.uid() and not private.is_admin()) then
    raise exception 'Kein Zugriff auf diesen Bericht.' using errcode = '42501';
  end if;
  select * into stored from public.monthly_summaries s
  where s.user_id = member_id and s.year = report_year and s.month = report_month and s.is_locked;
  if found then return to_jsonb(stored); end if;
  return to_jsonb(private.calculate_month(member_id, first_day));
end
$$;

create function public.close_month(member_id uuid, report_year integer, report_month integer)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  first_day date := make_date(report_year, report_month, 1);
  next_day date := (first_day + interval '1 month')::date;
  result public.monthly_summaries%rowtype;
begin
  perform private.assert_admin();
  perform private.lock_user(member_id);

  select * into result from public.monthly_summaries s
  where s.user_id = member_id and s.year = report_year and s.month = report_month and s.is_locked;
  if found then return to_jsonb(result); end if;

  if next_day > (clock_timestamp() at time zone 'Europe/Berlin')::date then
    raise exception 'Ein Monat kann erst nach seinem Ende abgeschlossen werden.';
  end if;
  if exists (select from public.monthly_summaries s where s.user_id = member_id and s.is_locked
    and (s.year, s.month) > (report_year, report_month)) then
    raise exception 'Ein späterer Monat ist bereits abgeschlossen.';
  end if;
  if exists (select from public.monthly_summaries s where s.user_id = member_id and s.is_locked)
    and not exists (select from public.monthly_summaries s where s.user_id = member_id and s.is_locked
       and make_date(s.year,s.month,1) = (first_day - interval '1 month')::date) then
    raise exception 'Bitte zuerst den vorherigen Monat abschließen, damit der Übertrag vollständig ist.';
  end if;
  if exists (
    select from public.time_entries e
    left join public.time_entries original on original.id = e.corrects_entry_id
    where e.user_id = member_id and e.status in ('open','submitted')
      and ((e.started_at at time zone 'Europe/Berlin')::date < next_day
        and (e.ended_at is null or (e.ended_at at time zone 'Europe/Berlin')::date >= first_day)
        or ((original.started_at at time zone 'Europe/Berlin')::date < next_day
          and (original.ended_at is null or (original.ended_at at time zone 'Europe/Berlin')::date >= first_day)))
  ) or exists (
    select from public.absences a where a.user_id = member_id and a.status = 'submitted'
      and a.start_date < next_day and a.end_date >= first_day
  ) then
    raise exception 'Für diesen Monat gibt es offene Buchungen oder Anträge.';
  end if;

  result := private.calculate_month(member_id, first_day);
  insert into public.monthly_summaries (user_id, year, month, target_minutes, worked_minutes,
    break_minutes, balance_minutes, carryover_minutes, vacation_days, sick_days, comp_time_days,
    is_locked, closed_by, closed_at)
  values (result.user_id, result.year, result.month, result.target_minutes, result.worked_minutes,
    result.break_minutes, result.balance_minutes, result.carryover_minutes, result.vacation_days,
    result.sick_days, result.comp_time_days, true, auth.uid(), clock_timestamp())
  on conflict (user_id, year, month) do update
  set target_minutes = excluded.target_minutes, worked_minutes = excluded.worked_minutes,
    break_minutes = excluded.break_minutes, balance_minutes = excluded.balance_minutes,
    carryover_minutes = excluded.carryover_minutes, vacation_days = excluded.vacation_days,
    sick_days = excluded.sick_days, comp_time_days = excluded.comp_time_days, is_locked = true,
    closed_by = excluded.closed_by, closed_at = excluded.closed_at
  returning * into result;
  return to_jsonb(result);
end
$$;

revoke all on function private.assert_admin(), private.calculate_month(uuid, date) from public, anon, authenticated;
revoke all on function public.review_correction(uuid, boolean), public.resolve_open_entry(uuid, timestamptz, text, integer),
  public.review_absence(uuid, boolean),
  public.record_absence(uuid, public.absence_type, date, date, text),
  public.read_monthly_report(uuid, integer, integer), public.close_month(uuid, integer, integer)
from public, anon;
grant execute on function public.review_correction(uuid, boolean), public.resolve_open_entry(uuid, timestamptz, text, integer),
  public.review_absence(uuid, boolean),
  public.record_absence(uuid, public.absence_type, date, date, text),
  public.read_monthly_report(uuid, integer, integer), public.close_month(uuid, integer, integer)
to authenticated;

commit;
