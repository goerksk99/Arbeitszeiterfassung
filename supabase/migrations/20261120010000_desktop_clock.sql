begin;

create function public.clock_in() returns uuid
language plpgsql set search_path = ''
as $$
declare
  member_id uuid := auth.uid();
  entry_id uuid;
begin
  if not private.is_active_member() then
    raise exception 'Ein aktives Profil ist erforderlich.' using errcode = '42501';
  end if;

  insert into public.time_entries (user_id, started_at, status)
  values (member_id, clock_timestamp(), 'open')
  returning id into entry_id;

  return entry_id;
end
$$;

create function public.clock_out(entry_id uuid, adjusted_break integer default null, entry_note text default null)
returns uuid
language plpgsql set search_path = ''
as $$
declare
  updated_id uuid;
begin
  if not private.is_active_member() then
    raise exception 'Ein aktives Profil ist erforderlich.' using errcode = '42501';
  end if;

  update public.time_entries
  set ended_at = clock_timestamp(),
      status = 'recorded',
      break_adjusted = adjusted_break is not null,
      break_minutes = coalesce(adjusted_break, 0),
      note = coalesce(nullif(btrim(entry_note), ''), note)
  where id = entry_id and user_id = auth.uid() and status = 'open'
  returning id into updated_id;

  if updated_id is null then
    raise exception 'Diese offene Buchung wurde bereits geändert.' using errcode = 'P0002';
  end if;
  return updated_id;
end
$$;

revoke all on function public.clock_in(), public.clock_out(uuid, integer, text) from public, anon;
grant execute on function public.clock_in(), public.clock_out(uuid, integer, text) to authenticated;

commit;
