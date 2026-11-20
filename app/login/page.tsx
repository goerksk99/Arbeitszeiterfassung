import { hasSupabaseConfig } from "../../lib/supabase/config";
import { signOut } from "./actions";
import LoginForm from "./form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ zugang?: string }>;
}) {
  const { zugang } = await searchParams;

  return (
    <main className="grid min-h-screen place-items-center bg-slate-100 px-4 py-10 text-slate-950">
      <section className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <p className="text-sm font-medium text-slate-600">Arbeitszeiterfassung</p>
        <h1 className="mt-2 text-3xl font-semibold">Anmelden</h1>
        {!hasSupabaseConfig() ? (
          <p role="status" className="mt-6">Die Anmeldung ist derzeit nicht eingerichtet.</p>
        ) : zugang === "fehlt" ? (
          <form action={signOut} className="mt-6">
            <p role="alert">Dein Konto hat kein aktives Profil. Bitte wende dich an die Geschäftsführung.</p>
            <button className="mt-4 underline">Abmelden</button>
          </form>
        ) : <LoginForm />}
      </section>
    </main>
  );
}
