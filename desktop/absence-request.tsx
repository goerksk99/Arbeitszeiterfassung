import { CalendarPlus, Coffee, HeartPulse, Palmtree, CalendarDays } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { berlinDate, type AbsenceType } from "../lib/work-time";
import { Modal } from "./modal";
import { supabase, type Profile } from "./supabase";
import { absenceColors, absenceLabels, absenceStatus, button, card, dayLabel, field, listMembers, Message, requestError, type Member, type Notice } from "./ui";

const kinds = [
  { value: "vacation", icon: Palmtree }, { value: "sick", icon: HeartPulse },
  { value: "comp_time", icon: Coffee }, { value: "other", icon: CalendarDays },
] as const;
type Request = { id: string; type: AbsenceType; start_date: string; end_date: string; status: keyof typeof absenceStatus };

export function AbsenceRequest({ profile }: { profile: Profile }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<AbsenceType>("vacation");
  const [direct, setDirect] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [requests, setRequests] = useState<Request[]>();
  const [notice, setNotice] = useState<Notice>();
  const [historyError, setHistoryError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const admin = profile.role === "admin";
  const today = berlinDate(new Date().toISOString());

  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    if (admin && direct) void listMembers(signal).then((list) => {
      if (!signal.aborted) setMembers(list.filter((item) => item.is_active));
    }).catch(() => {
      if (!signal.aborted) setNotice({ text: "Mitarbeiterliste konnte nicht geladen werden.", error: true });
    });
    return () => controller.abort();
  }, [admin, direct]);

  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    void supabase.from("absences").select("id, type, start_date, end_date, status").eq("user_id", profile.id)
      .order("created_at", { ascending: false }).abortSignal(signal).then(({ data, error }) => {
        if (signal.aborted) return;
        setHistoryError(Boolean(error));
        if (!error) setRequests(data as Request[]);
      });
    return () => controller.abort();
  }, [profile.id, refresh]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const from = String(values.get("from"));
    const until = String(values.get("until"));
    const note = String(values.get("note") ?? "").trim();
    if (from > until) {
      setNotice({ text: "Das Enddatum muss am oder nach dem Startdatum liegen.", error: true });
      return;
    }
    setBusy(true);
    setNotice(undefined);
    try {
      const response = admin && direct
        ? await supabase.rpc("record_absence", {
          member_id: String(values.get("member")), kind, first_day: from, last_day: until, entry_note: note,
        })
        : await supabase.from("absences").insert({
          user_id: profile.id, type: kind, start_date: from, end_date: until, note: note || null, status: "submitted",
        });
      if (response.error) throw response.error;
      form.reset();
      setOpen(false);
      setNotice({ text: direct ? "Abwesenheit eingetragen und genehmigt." : "Antrag abgeschickt. Du siehst den Status unter „Meine Anträge“." });
      setRefresh((count) => count + 1);
    } catch (error) { setNotice({ text: requestError(error), error: true }); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-5">
      {open && <Modal title={admin && direct ? "Abwesenheit eintragen" : "Neuer Abwesenheitsantrag"} busy={busy} onClose={() => setOpen(false)}>
        {admin && <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={direct}
          disabled={busy} onChange={(event) => { setDirect(event.target.checked); setNotice(undefined); }} />Für jemanden direkt eintragen und genehmigen</label>}
        <form onSubmit={submit} className="mt-5 space-y-4">
          {admin && direct && <label>Mitarbeiter<select name="member" required className={field} defaultValue={profile.id}>
            {members.map((member) => <option key={member.id} value={member.id}>{member.full_name}</option>)}
          </select></label>}
          <fieldset>
            <legend className="mb-2 text-sm font-semibold">Art der Abwesenheit</legend>
            <div className="absence-kinds">
              {kinds.map(({ value, icon: Icon }) => <button key={value} aria-pressed={kind === value} type="button"
                className={`absence-kind ${kind === value ? "is-selected" : ""}`} onClick={() => setKind(value)}>
                <Icon size={21} aria-hidden="true" />{absenceLabels[value]}
              </button>)}
            </div>
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <label>Von<input name="from" type="date" className={field} defaultValue={today} required /></label>
            <label>Bis<input name="until" type="date" className={field} defaultValue={today} required /></label>
          </div>
          <label className="block">Notiz (optional)<textarea name="note" className={field} maxLength={500} rows={2} /></label>
          <button className={button} disabled={busy || (direct && !members.length)}><CalendarPlus size={18} aria-hidden="true" />{direct ? "Eintragen" : "Antrag abschicken"}</button>
          <Message notice={notice?.error ? notice : undefined} />
        </form>
      </Modal>}
      <section className={card}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="panel-heading">Meine Anträge</h2>
          <button className={button} type="button" onClick={() => { setDirect(false); setKind("vacation"); setNotice(undefined); setOpen(true); }}>
            <CalendarPlus size={18} aria-hidden="true" />Neuer Antrag
          </button>
        </div>
        {!open && notice && <div className="mt-3"><Message notice={notice} /></div>}
        {historyError ? <p className="muted-notice" role="alert">Die Anträge konnten nicht geladen werden.</p>
          : !requests ? <p className="muted-notice">Anträge werden geladen …</p>
          : !requests.length ? <p className="muted-notice">Du hast noch keine Abwesenheiten eingetragen.</p>
          : <ul className="request-history">
            {requests.map((item) => <li key={item.id}>
              <div><span className={`rounded px-2 py-1 ${absenceColors[item.type]}`}>{absenceLabels[item.type]}</span>
                <p>{dayLabel(item.start_date)}{item.start_date !== item.end_date && ` – ${dayLabel(item.end_date)}`}</p></div>
              <span className={`entry-status entry-status--${item.status}`}>{absenceStatus[item.status]}</span>
            </li>)}
          </ul>}
      </section>
    </div>
  );
}
