import { useState, type FormEvent } from "react";
import { Modal } from "./modal";
import { supabase } from "./supabase";
import { button, field, Message, secondary, type Notice } from "./ui";

export type EmailAuthMode = "invite" | "recovery";

export function EmailAuth({ mode, onClose, onComplete }: {
  mode: EmailAuthMode; onClose: () => void; onComplete: () => void;
}) {
  const [step, setStep] = useState<"email" | "code" | "password">(mode === "invite" ? "code" : "email");
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    setPending(true);
    setNotice(undefined);
    try {
      if (step === "email") {
        const address = String(values.get("email") ?? "").trim();
        const { error } = await supabase.auth.resetPasswordForEmail(address);
        if (error) {
          setNotice({ text: "Der E-Mail-Code konnte gerade nicht angefordert werden. Versuche es später erneut oder melde dich bei der Verwaltung.", error: true });
          return;
        }
        setEmail(address);
        setStep("code");
        setNotice({ text: "Wenn es zu dieser Adresse ein Konto gibt, erhältst du einen Code per E-Mail." });
      } else if (step === "code") {
        const address = String(values.get("email") ?? email).trim();
        const token = String(values.get("code") ?? "").replace(/\s/g, "");
        const { data, error } = await supabase.auth.verifyOtp({ email: address, token, type: mode });
        if (error || !data.session) {
          setNotice({ text: "Der Code ist ungültig oder abgelaufen. Prüfe die E-Mail-Adresse und den neuesten Code.", error: true });
          return;
        }
        setStep("password");
      } else {
        const password = String(values.get("password") ?? "");
        if (password !== values.get("confirm") || new TextEncoder().encode(password).length > 72) {
          setNotice({ text: "Die Passwörter müssen übereinstimmen und dürfen höchstens 72 UTF-8-Bytes haben.", error: true });
          return;
        }
        const { error } = await supabase.auth.updateUser({ password });
        if (error) {
          setNotice({ text: "Das Passwort konnte nicht gespeichert werden. Wähle ein anderes Passwort oder fordere einen neuen Code an.", error: true });
          return;
        }
        await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
        onComplete();
      }
    } catch {
      setNotice({ text: "Die Verbindung ist fehlgeschlagen. Bitte versuche es erneut.", error: true });
    } finally { setPending(false); }
  }

  async function close() {
    if (pending) return;
    if (step === "password") {
      setPending(true);
      await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
    }
    onClose();
  }

  return <Modal title={mode === "invite" ? "Einladung einlösen" : "Passwort per E-Mail zurücksetzen"} busy={pending} onClose={() => void close()}>
    <Message notice={notice} />
    <form key={step} className="mt-3 space-y-4" onSubmit={submit}>
      {step !== "password" && <label className="block">Geschäftliche E-Mail-Adresse
        <input name="email" className={field} type="email" defaultValue={email} required autoComplete="email" />
      </label>}
      {step === "code" && <label className="block">Code aus der E-Mail
        <input name="code" className={field} inputMode="numeric" pattern="[0-9]{6,10}" autoComplete="one-time-code" required />
      </label>}
      {step === "password" && <>
        <label className="block">Neues Passwort<input name="password" className={field} type="password" minLength={12} maxLength={72} autoComplete="new-password" required /></label>
        <label className="block">Passwort wiederholen<input name="confirm" className={field} type="password" minLength={12} maxLength={72} autoComplete="new-password" required /></label>
      </>}
      <div className="flex flex-wrap gap-2">
        <button className={button} disabled={pending}>{step === "email" ? "Code anfordern" : step === "code" ? "Code bestätigen" : "Passwort speichern"}</button>
        {step === "code" && mode === "recovery" && <button type="button" className={secondary} disabled={pending} onClick={() => { setNotice(undefined); setStep("email"); }}>Neuen Code anfordern</button>}
      </div>
    </form>
  </Modal>;
}
