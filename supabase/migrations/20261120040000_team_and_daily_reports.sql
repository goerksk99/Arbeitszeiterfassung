begin;

alter table public.profiles add column department text
  check (department in ('management','sales','dispatch','accounting'));

create table public.team_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 60)
);
create unique index team_groups_unique_name on public.team_groups (lower(btrim(name)));
create table public.team_group_members (
  group_id uuid not null references public.team_groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  primary key (group_id, user_id)
);
alter table public.team_groups enable row level security;
alter table public.team_group_members enable row level security;
revoke all on public.team_groups, public.team_group_members from public, anon, authenticated;
grant select, insert, update, delete on public.team_groups to authenticated;
grant select on public.team_group_members to authenticated;
create policy team_groups_read on public.team_groups for select to authenticated using (private.is_active_member());
create policy team_groups_admin on public.team_groups for all to authenticated using (private.is_admin()) with check (private.is_admin());
create policy membership_admin on public.team_group_members for select to authenticated using (private.is_admin());

create function public.save_staff_details(member_id uuid, member_name text, hours numeric,
  leave_days numeric, active boolean, member_department text, group_ids uuid[])
returns void language plpgsql security definer set search_path = ''
as $$
begin
  perform private.assert_admin();
  perform private.lock_user(member_id);
  update public.profiles set full_name = btrim(member_name), weekly_hours = hours,
    annual_leave_days = leave_days, is_active = case when member_id = auth.uid() then true else active end,
    department = nullif(member_department, '')
  where id = member_id;
  if not found then raise exception 'Profil nicht gefunden.' using errcode = 'P0002'; end if;
  delete from public.team_group_members where user_id = member_id;
  insert into public.team_group_members (group_id, user_id)
  select distinct g.id, member_id from unnest(group_ids) g(id);
end
$$;

create function public.team_calendar_details(first_day date, last_day date)
returns table (id uuid, user_id uuid, full_name text, type public.absence_type,
  start_date date, end_date date, status public.absence_status, department text, group_ids uuid[])
language sql stable security definer set search_path = ''
as $$
  select a.id, a.user_id, a.full_name, a.type, a.start_date, a.end_date, a.status, p.department,
    array(select m.group_id from public.team_group_members m where m.user_id = a.user_id order by m.group_id)
  from public.team_calendar(first_day, last_day) a join public.profiles p on p.id = a.user_id
$$;

-- Gregorian Easter Sunday for nationwide German holidays.
create function private.easter_sunday(y integer) returns date
language sql immutable strict set search_path = ''
as $$
  with part as (select y % 19 as a, y / 100 as b, y % 100 as c),
  next_part as (select *, (19*a + b - b/4 - (b-(b+8)/25+1)/3 + 15) % 30 as h from part),
  adjusted as (select *, (32 + 2*(b%4) + 2*(c/4) - h - c%4) % 7 as l from next_part),
  result as (select h+l-7*((a+11*h+22*l)/451)+114 as n from adjusted)
  select make_date(y, n/31, n%31+1) from result
$$;

create function private.german_holiday(day date) returns text
language sql immutable strict set search_path = ''
as $$
  select case
    when extract(month from day)=1 and extract(day from day)=1 then 'Neujahr'
    when extract(month from day)=5 and extract(day from day)=1 then 'Tag der Arbeit'
    when extract(month from day)=10 and extract(day from day)=3 then 'Tag der Deutschen Einheit'
    when extract(month from day)=12 and extract(day from day)=25 then '1. Weihnachtstag'
    when extract(month from day)=12 and extract(day from day)=26 then '2. Weihnachtstag'
    else case day - private.easter_sunday(extract(year from day)::integer)
      when -2 then 'Karfreitag' when 1 then 'Ostermontag'
      when 39 then 'Christi Himmelfahrt' when 50 then 'Pfingstmontag'
    end
  end
$$;

create function public.company_holidays(first_day date, last_day date)
returns table (day date, name text)
language sql stable security definer set search_path = ''
as $$
  select first_day + d.offset_days, holiday.name
  from generate_series(0, least(last_day - first_day, 366)) d(offset_days)
  cross join lateral (select private.german_holiday(first_day + d.offset_days) as name) holiday
  where private.is_active_member() and holiday.name is not null
$$;

alter table public.monthly_summaries add column daily_breakdown jsonb;

create function private.daily_month(member_id uuid, first_day date, use_holidays boolean)
returns table (day date, target_minutes integer, worked_minutes integer, break_minutes integer,
  difference_minutes integer, absence_type public.absence_type, holiday text)
language sql stable set search_path = ''
as $$
  with dates as (
    select first_day + d.offset_days as day
    from generate_series(0, (first_day + interval '1 month')::date - first_day - 1) d(offset_days)
  ), entries as (
    select (e.started_at at time zone 'Europe/Berlin')::date as day,
      sum(floor(extract(epoch from (e.ended_at-e.started_at))/60)-e.break_minutes)::integer as worked,
      sum(e.break_minutes)::integer as breaks
    from public.time_entries e
    where e.user_id=member_id and e.started_at >= (first_day::timestamp at time zone 'Europe/Berlin')
      and e.started_at < ((first_day + interval '1 month') at time zone 'Europe/Berlin')
      and e.status in ('recorded','approved') and e.corrects_entry_id is null
    group by 1
  ), base as (
    select d.day, p.weekly_hours, coalesce(e.worked,0) as worked, coalesce(e.breaks,0) as breaks,
      case when extract(isodow from d.day)<=5 and h.holiday is null then a.type end as absence, h.holiday,
      case when extract(isodow from d.day)<=5 and h.holiday is null and (a.type is null or a.type='comp_time')
        then 1 else 0 end as target_day
    from dates d cross join public.profiles p
    left join entries e on e.day=d.day
    left join public.absences a on a.user_id=member_id and a.status='approved' and d.day between a.start_date and a.end_date
    cross join lateral (select case when use_holidays then private.german_holiday(d.day) end as holiday) h
    where p.id=member_id
  ), cumulative as (
    select *, sum(target_day) over (order by day) as eligible_days from base
  ), minutes as (
    select *, (round(eligible_days*weekly_hours*12)-round((eligible_days-target_day)*weekly_hours*12))::integer as target
    from cumulative
  )
  select day, target, worked, breaks, worked-target, absence, holiday from minutes order by day
$$;

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
  select sum(d.target_minutes), sum(d.worked_minutes), sum(d.break_minutes),
    count(*) filter (where d.absence_type='vacation'), count(*) filter (where d.absence_type='sick'),
    count(*) filter (where d.absence_type='comp_time')
  into result.target_minutes, result.worked_minutes, result.break_minutes,
    result.vacation_days, result.sick_days, result.comp_time_days
  from private.daily_month(member_id, first_day, true) d;
  select coalesce((select s.balance_minutes from public.monthly_summaries s
    where s.user_id = member_id and s.is_locked
      and s.year = extract(year from last_month) and s.month = extract(month from last_month)), 0)
  into result.carryover_minutes;
  result.balance_minutes := result.carryover_minutes + result.worked_minutes - result.target_minutes;
  return result;
end
$$;

create function private.snapshot_daily_month() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.is_locked and (tg_op = 'INSERT' or not old.is_locked) then
    select jsonb_agg(to_jsonb(d) order by d.day) into new.daily_breakdown
    from private.daily_month(new.user_id, make_date(new.year,new.month,1), true) d;
  elsif tg_op = 'UPDATE' then
    new.daily_breakdown := old.daily_breakdown;
  end if;
  return new;
end
$$;
create trigger snapshot_daily_month before insert or update on public.monthly_summaries
for each row execute function private.snapshot_daily_month();

create function public.read_daily_report(member_id uuid, report_year integer, report_month integer)
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
      not (report->>'is_locked')::boolean) d;
  end if;
  return jsonb_build_object('days', rows, 'archived', stored,
    'reconstructed', (report->>'is_locked')::boolean and not stored);
end
$$;

create function public.read_annual_leave(report_year integer)
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
  from public.profiles p where p.id=auth.uid() and p.is_active
$$;

revoke all on function private.easter_sunday(integer), private.german_holiday(date),
  private.daily_month(uuid,date,boolean), private.snapshot_daily_month() from public, anon, authenticated;
revoke all on function public.company_holidays(date,date), public.team_calendar_details(date,date),
  public.save_staff_details(uuid,text,numeric,numeric,boolean,text,uuid[]),
  public.read_daily_report(uuid,integer,integer), public.read_annual_leave(integer) from public, anon;
grant execute on function public.company_holidays(date,date), public.team_calendar_details(date,date),
  public.save_staff_details(uuid,text,numeric,numeric,boolean,text,uuid[]),
  public.read_daily_report(uuid,integer,integer), public.read_annual_leave(integer) to authenticated;

commit;
