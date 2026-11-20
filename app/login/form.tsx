"use client";

import { useActionState } from "react";
import { signIn } from "./actions";

export default function LoginForm() {
  const [error, action, pending] = useActionState(signIn, "");

  return (
    <form action={action} className="mt-8 space-y-5">
      <label className="block text-sm font-medium">
        E-Mail-Adresse
        <input name="email" type="email" required autoComplete="username"
          className="mt-2 block w-full rounded-lg border border-slate-300 px-3 py-2" />
      </label>
      <label className="block text-sm font-medium">
        Passwort
        <input name="password" type="password" required autoComplete="current-password"
          className="mt-2 block w-full rounded-lg border border-slate-300 px-3 py-2" />
      </label>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <button type="submit" disabled={pending}
        className="w-full rounded-lg bg-slate-900 px-4 py-3 font-medium text-white disabled:opacity-60">
        {pending ? "Anmeldung läuft …" : "Anmelden"}
      </button>
    </form>
  );
}
