import { Temporal } from "@js-temporal/polyfill";
import { ArrowRight, CirclePause, Clock3, LogIn, LogOut, Play, Timer } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { COMPANY_ZONE } from "../lib/work-time";
import { supabase, type Profile } from "./supabase";
import { duration, entryColumns, optionalBreak, time, type Entry } from "./time-display";
import type { ClockAction } from "./desktop-api";
import { card, field, Message, requestError, secondary, type Notice } from "./ui";

type BreakState = { entry_id: string; paused_at: string | null; finished_seconds: number };
type Shift = { open: Entry | null; breakState: BreakState | null; canPause: boolean; automaticLunch: boolean; worked: number; pauses: number };
const todayLabel = new Intl.DateTimeFormat("de-DE", { timeZone: COMPANY_ZONE, dateStyle: "full" });

export function Clock({ profile, onEntries, onTrayError }: { profile: Profile; onEntries: () => void; onTrayError: () => void }) {
  const [now, setNow] = useState(Date.now);
  const [shift, setShift] = useState<Shift>();
  const [notice, setNotice] = useState<Notice>();
  const [loadError, setLoadError] = useState(false);
  const [options, setOptions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const actionLock = useRef(false);
  const [refresh, setRefresh] = useState(0);
  const today = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(COMPANY_ZONE).toPlainDate().toString();

  useEffect(() => {
    const ticker = window.setInterval(() => setNow(Date.now()), 1000);
    const refreshStatus = () => { if (!actionLock.current) setRefresh((value) => value + 1); };
    const polling = window.setInterval(refreshStatus, 30000);
    window.addEventListener("focus", refreshStatus);
    return () => {
      window.clearInterval(ticker);
      window.clearInterval(polling);
      window.removeEventListener("focus", refreshStatus);
      window.desktop?.setTrayState({ status: "signed-out", canPause: false, busy: false });
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const day = Temporal.PlainDate.from(today);
    const start = day.toZonedDateTime(COMPANY_ZONE).toInstant().toString();
    const end = day.add({ days: 1 }).toZonedDateTime(COMPANY_ZONE).toInstant().toString();
    const signal = controller.signal;
    async function load() {
      const [open, breaks, done, settingsMember] = await Promise.all([
        supabase.from("time_entries").select(entryColumns).eq("user_id", profile.id)
          .eq("status", "open").abortSignal(signal).maybeSingle(),
        supabase.rpc("clock_break_status").abortSignal(signal),
        supabase.from("time_entries").select("started_at, ended_at, break_minutes")
          .eq("user_id", profile.id).is("corrects_entry_id", null).in("status", ["recorded", "approved"])
          .gte("started_at", start).lt("started_at", end).abortSignal(signal),
        supabase.from("profiles").select("automatic_lunch_break").eq("id", profile.id).abortSignal(signal).single(),
      ]);
      if (signal.aborted) return;
      if (open.error || done.error || settingsMember.error || (breaks.error && breaks.error.code !== "PGRST202")) {
        setShift(undefined);
        setLoadError(true);
        return;
      }
      const active = open.data as Entry | null;
      const clockBreak = breaks.data as BreakState | null;
      let worked = 0;
      let pauses = 0;
      for (const entry of done.data ?? []) {
        worked += Math.floor((Date.parse(entry.ended_at) - Date.parse(entry.started_at)) / 60000) - entry.break_minutes;
        pauses += entry.break_minutes;
      }
      setShift({ open: active, breakState: clockBreak?.entry_id === active?.id ? clockBreak : null,
        canPause: !breaks.error, automaticLunch: settingsMember.data?.automatic_lunch_break ?? true, worked, pauses });
      setLoadError(false);
    }
    void load().catch(() => { if (!signal.aborted) { setShift(undefined); setLoadError(true); } })
      .finally(() => { if (!signal.aborted) setSyncing(false); });
    return () => controller.abort();
  }, [profile.id, refresh, today]);

  const open = shift?.open;
  const pausedAt = shift?.breakState?.paused_at;
  const startedToday = open && Temporal.Instant.from(open.started_at).toZonedDateTimeISO(COMPANY_ZONE).toPlainDate().toString() === today;
  const pauseElapsed = pausedAt ? Math.max(0, Math.floor((now - Date.parse(pausedAt)) / 1000)) : 0;
  const activePaused = (shift?.breakState?.finished_seconds ?? 0) + pauseElapsed;
  const elapsed = open ? Math.max(0, Math.floor((now - Date.parse(open.started_at)) / 1000) - activePaused) : 0;
  const displayedSeconds = pausedAt ? pauseElapsed : elapsed;
  const counter = [Math.floor(displayedSeconds / 3600), Math.floor(displayedSeconds / 60) % 60, displayedSeconds % 60]
    .map((value) => String(value).padStart(2, "0")).join(":");

  const performAction = useCallback(async (action: ClockAction, adjustedBreak: number | null = null, note = "", fromTray = false) => {
    if (actionLock.current || syncing || !shift) return false;
    if ((action === "in" && open) || (action !== "in" && !open) ||
        (action === "pause" && (pausedAt || !shift.canPause)) || (action === "resume" && !pausedAt)) return false;
    actionLock.current = true;
    setBusy(true);
    setNotice(undefined);
    try {
      const result = action === "in" ? await supabase.rpc("clock_in") : action === "out"
        ? await supabase.rpc("clock_out", { entry_id: open!.id, adjusted_break: adjustedBreak, entry_note: note })
        : await supabase.rpc("set_clock_break", { entry_id: open!.id, start_break: action === "pause" });
      if (result.error) throw result.error;
      const messages = { in: "Einstempeln gespeichert.", out: "Ausstempeln gespeichert.",
        pause: "Pause gestartet.", resume: "Pause beendet." };
      setNotice({ text: messages[action] });
      if (action === "in" || action === "out") setShift(undefined);
      setSyncing(true);
      setRefresh((value) => value + 1);
      return true;
    } catch (error) {
      setNotice({ text: requestError(error), error: true });
      if (fromTray) {
        onTrayError();
        window.desktop?.showClockProblem();
      }
      setRefresh((value) => value + 1);
      return false;
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }, [shift, open, pausedAt, syncing, onTrayError]);

  const status = !shift ? "loading" : pausedAt ? "paused" : open ? "working" : "stopped";
  const canPause = shift?.canPause ?? false;
  useEffect(() => {
    window.desktop?.setTrayState({ status, canPause, busy: busy || syncing });
  }, [status, canPause, busy, syncing]);

  useEffect(() => window.desktop?.onTrayAction((action) => { void performAction(action, null, "", true); }), [performAction]);

  async function perform(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const pauseButton = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "pause";
    const action = !open ? "in" : pauseButton ? (pausedAt ? "resume" : "pause") : "out";
    const data = new FormData(form);
    try {
      const minutes = action === "out" ? optionalBreak(data.get("pause")) ?? null : null;
      if (await performAction(action, minutes, String(data.get("note") ?? "")) && (action === "in" || action === "out")) {
        form.reset();
        setOptions(false);
      }
    } catch (error) {
      setNotice({ text: error instanceof RangeError ? error.message : "Die Pausendauer ist ungültig.", error: true });
    }
  }

  return (
    <div className="space-y-5">
      {loadError && <div className={card}><p role="alert">Der aktuelle Status konnte nicht geladen werden.</p>
        <button className={`${secondary} mt-3`} onClick={() => setRefresh((value) => value + 1)}>Erneut laden</button>
      </div>}
      <section className={`clock-hero ${pausedAt ? "clock-hero--pause" : ""}`}>
        <div className="clock-main">
          <div className="clock-date"><Clock3 size={17} aria-hidden="true" />{todayLabel.format(now)}</div>
          <div className={`status-chip ${pausedAt ? "status-chip--pause" : open ? "status-chip--work" : ""}`}>
            <span aria-hidden="true" />{!shift ? "Status wird geladen" : pausedAt ? "In Pause" : open ? "Eingestempelt" : "Ausgestempelt"}
          </div>
          <p className="clock-counter" aria-hidden="true">{counter}</p>
          <p className="clock-caption">{pausedAt ? `Pause seit ${time.format(Date.parse(pausedAt))} Uhr`
            : open ? `Eingestempelt seit ${time.format(Date.parse(open.started_at))} Uhr` : "Bereit zum Einstempeln"}</p>
          {open && !startedToday && <p className="clock-warning">Deine offene Buchung stammt von einem früheren Tag.</p>}
          <form className="clock-actions" onSubmit={perform}>
            <div className="flex flex-wrap items-center gap-3">
              {!open ? <button className="clock-primary" value="stamp" disabled={!shift || busy || syncing}><LogIn size={20} aria-hidden="true" />Einstempeln</button>
                : <>
                  {shift?.canPause && <button className={pausedAt ? "clock-primary" : "clock-pause-button"} value="pause" disabled={busy || syncing}>
                    {pausedAt ? <Play size={18} aria-hidden="true" /> : <CirclePause size={19} aria-hidden="true" />}
                    {pausedAt ? "Pause beenden" : "Pause starten"}
                  </button>}
                  <button className="clock-secondary" value="stamp" disabled={busy || syncing}><LogOut size={19} aria-hidden="true" />Ausstempeln</button>
                </>}
            </div>
            {open && <details className="clock-options" open={options} onToggle={(event) => setOptions(event.currentTarget.open)}>
              <summary>Notiz oder Pause anpassen</summary>
              <div className="grid gap-3 sm:grid-cols-2">
                <label>Notiz<input className={field} name="note" maxLength={500} /></label>
                <label>Pausendauer in Minuten<input className={field} name="pause" type="number" min="0" step="1"
                  placeholder={shift?.breakState ? "Gemessene Dauer" : shift?.automaticLunch ? "Automatisch" : "0 Minuten"} /></label>
              </div>
            </details>}
          </form>
        </div>
        <aside className="clock-summary">
          <div className="clock-summary-title"><Timer size={19} aria-hidden="true" /> Heute</div>
          <dl>
            <div><dt>Arbeitszeit</dt><dd>{duration((shift?.worked ?? 0) + (startedToday ? Math.floor(elapsed / 60) : 0))} <small>Std.</small></dd></div>
            <div><dt>Pause</dt><dd>{duration((shift?.pauses ?? 0) + (startedToday ? Math.floor(activePaused / 60) : 0))} <small>Std.</small></dd></div>
          </dl>
          <button type="button" className="clock-link" onClick={onEntries}>Arbeitszeiten ansehen <ArrowRight size={17} aria-hidden="true" /></button>
        </aside>
      </section>
      {shift && !shift.canPause && <p className="muted-notice">Die Pausentaste erscheint, sobald das Pausen-Update in Supabase eingespielt ist.</p>}
      <Message notice={notice} />
    </div>
  );
}
