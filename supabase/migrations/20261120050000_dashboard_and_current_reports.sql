begin;

create or replace function private.calculate_month(member_id uuid, first_day date)
returns public.monthly_summaries
language plpgsql stable set search_path = ''
as $$
declare
  result public.monthly_summaries%rowtype;
  last_month date := (first_day - interval '1 month')::date;
begin
  if not exists (select from public.profiles where id=member_id) then
    raise exception 'Profil nicht gefunden.' using errcode='P0002';
  end if;
  result.user_id := member_id;
  result.year := extract(year from first_day);
  result.month := extract(month from first_day);
  result.is_locked := false;
  select coalesce(sum(d.target_minutes),0), coalesce(sum(d.worked_minutes),0), coalesce(sum(d.break_minutes),0),
    count(*) filter (where d.absence_type='vacation'), count(*) filter (where d.absence_type='sick'),
    count(*) filter (where d.absence_type='comp_time')
  into result.target_minutes, result.worked_minutes, result.break_minutes,
    result.vacation_days, result.sick_days, result.comp_time_days
  from private.daily_month(member_id, first_day, true) d
  where d.day <= (statement_timestamp() at time zone 'Europe/Berlin')::date;
  select coalesce((select s.balance_minutes from public.monthly_summaries s
    where s.user_id = member_id and s.is_locked
      and s.year = extract(year from last_month) and s.month = extract(month from last_month)), 0)
  into result.carryover_minutes;
  result.balance_minutes := result.carryover_minutes + result.worked_minutes - result.target_minutes;
  return result;
end
$$;

create or replace function public.read_daily_report(member_id uuid, report_year integer, report_month integer)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  stored boolean;
  report jsonb;
  rows jsonb;
begin
  report := public.read_monthly_report(member_id, report_year, report_month);
  rows := report->'daily_breakdown';
  stored := rows is not null and rows <> 'null'::jsonb;
  if not stored then
    select jsonb_agg(to_jsonb(d) order by d.day) into rows
    from private.daily_month(member_id, make_date(report_year, report_month, 1),
      not (report->>'is_locked')::boolean) d
    where (report->>'is_locked')::boolean or d.day <= (statement_timestamp() at time zone 'Europe/Berlin')::date;
  end if;
  return jsonb_build_object('days', coalesce(rows, '[]'::jsonb), 'archived', stored,
    'reconstructed', (report->>'is_locked')::boolean and not stored);
end
$$;

create or replace function public.team_calendar(first_day date, last_day date)
returns table (
  id uuid, user_id uuid, full_name text, type public.absence_type,
  start_date date, end_date date, status public.absence_status
)
language sql stable security definer set search_path = ''
as $$
  select a.id, a.user_id, p.full_name, a.type, a.start_date, a.end_date, a.status
  from public.absences a join public.profiles p on p.id = a.user_id
  where first_day <= last_day and a.start_date <= last_day and a.end_date >= first_day
    and a.status = 'approved' and private.is_active_member()
    and (private.is_admin() or a.user_id = auth.uid() or
      a.type <> 'sick')
$$;

alter table public.time_entries add column decided_at timestamptz;
alter table public.absences add column decided_at timestamptz;

create function private.stamp_request_decision() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.decided_at := null;
  elsif old.status = 'submitted' and new.status in ('approved','rejected') then
    new.decided_at := clock_timestamp();
  else
    new.decided_at := old.decided_at;
  end if;
  return new;
end
$$;

create trigger stamp_request_decision before insert or update on public.time_entries
for each row execute function private.stamp_request_decision();
create trigger stamp_request_decision before insert or update on public.absences
for each row execute function private.stamp_request_decision();
revoke all on function private.stamp_request_decision() from public, anon, authenticated;

create function public.admin_pause_details()
returns table (user_id uuid, paused_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.assert_admin();
  return query select e.user_id, b.paused_at
  from private.clock_breaks b join public.time_entries e on e.id = b.entry_id
  where b.paused_at is not null and e.status='open';
end
$$;

revoke all on function public.admin_pause_details() from public, anon;
grant execute on function public.admin_pause_details() to authenticated;

commit;
