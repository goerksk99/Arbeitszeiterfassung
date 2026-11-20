begin;

create table private.clock_breaks (
  entry_id uuid primary key references public.time_entries(id) on delete cascade,
  paused_at timestamptz,
  finished_seconds bigint not null default 0 check (finished_seconds >= 0)
);
revoke all on private.clock_breaks from public, anon, authenticated;

create function public.clock_break_status() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('entry_id', b.entry_id, 'paused_at', b.paused_at, 'finished_seconds', b.finished_seconds)
  from private.clock_breaks b join public.time_entries e on e.id = b.entry_id
  where e.user_id = auth.uid() and e.status = 'open' and private.is_active_member()
$$;

create function public.set_clock_break(entry_id uuid, start_break boolean) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  member_id uuid := auth.uid();
  started timestamptz;
  changed_at timestamptz;
begin
  if not private.is_active_member() then
    raise exception 'Ein aktives Profil ist erforderlich.' using errcode = '42501';
  end if;

  perform private.lock_user(member_id);
  select e.started_at into started from public.time_entries e
  where e.id = set_clock_break.entry_id and e.user_id = member_id and e.status = 'open'
  for update;
  if not found then
    raise exception 'Diese offene Buchung wurde bereits geändert.' using errcode = 'P0002';
  end if;
  changed_at := clock_timestamp();
  perform private.assert_unlocked(member_id, (started at time zone 'Europe/Berlin')::date,
    (changed_at at time zone 'Europe/Berlin')::date);

  if start_break then
    insert into private.clock_breaks (entry_id, paused_at)
    values (set_clock_break.entry_id, changed_at)
    on conflict on constraint clock_breaks_pkey do update
    set paused_at = coalesce(private.clock_breaks.paused_at, excluded.paused_at);
  else
    update private.clock_breaks b
    set finished_seconds = b.finished_seconds + greatest(0, floor(extract(epoch from changed_at - b.paused_at)))::bigint,
        paused_at = null
    where b.entry_id = set_clock_break.entry_id and b.paused_at is not null;
  end if;
end
$$;

create or replace function public.clock_out(entry_id uuid, adjusted_break integer default null, entry_note text default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  member_id uuid := auth.uid();
  started timestamptz;
  stopped timestamptz;
  tracked private.clock_breaks%rowtype;
  paused_seconds bigint;
  effective_break integer := adjusted_break;
begin
  if not private.is_active_member() then
    raise exception 'Ein aktives Profil ist erforderlich.' using errcode = '42501';
  end if;

  perform private.lock_user(member_id);
  select e.started_at into started from public.time_entries e
  where e.id = clock_out.entry_id and e.user_id = member_id and e.status = 'open' for update;
  if not found then
    raise exception 'Diese offene Buchung wurde bereits geändert.' using errcode = 'P0002';
  end if;
  stopped := clock_timestamp();
  perform private.assert_unlocked(member_id, (started at time zone 'Europe/Berlin')::date,
    (stopped at time zone 'Europe/Berlin')::date);

  select * into tracked from private.clock_breaks b where b.entry_id = clock_out.entry_id;
  if found then
    paused_seconds := tracked.finished_seconds;
    if tracked.paused_at is not null then
      paused_seconds := paused_seconds + greatest(0, floor(extract(epoch from stopped - tracked.paused_at)))::bigint;
    end if;
    if effective_break is null then effective_break := (paused_seconds / 60)::integer; end if;
    update private.clock_breaks b set finished_seconds = paused_seconds, paused_at = null
    where b.entry_id = clock_out.entry_id;
  end if;

  update public.time_entries e
  set ended_at = stopped,
      status = 'recorded',
      break_adjusted = effective_break is not null,
      break_minutes = coalesce(effective_break, 0),
      note = coalesce(nullif(btrim(entry_note), ''), e.note)
  where e.id = clock_out.entry_id;
  return clock_out.entry_id;
end
$$;

create function public.admin_paused_members() returns uuid[]
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.assert_admin();
  return coalesce((select array_agg(e.user_id)
    from private.clock_breaks b join public.time_entries e on e.id = b.entry_id
    where b.paused_at is not null and e.status = 'open'), '{}'::uuid[]);
end
$$;

revoke all on function public.admin_paused_members(), public.clock_break_status(), public.set_clock_break(uuid, boolean),
  public.clock_out(uuid, integer, text) from public, anon;
grant execute on function public.admin_paused_members(), public.clock_break_status(), public.set_clock_break(uuid, boolean),
  public.clock_out(uuid, integer, text) to authenticated;

commit;
