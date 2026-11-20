import Link from "next/link";
import { requireProfile } from "../../lib/auth";
import { signOut } from "../login/actions";

export default async function DashboardPage() {
  const profile = await requireProfile();

  return (
    <main className="mx-auto max-w-3xl px-6 py-20">
      <h1 className="text-3xl font-semibold">Willkommen, {profile.name}</h1>
      {profile.role === "admin" && (
        <Link href="/admin" className="mt-5 inline-block underline">Zum Admin-Bereich</Link>
      )}
      <form action={signOut} className="mt-6">
        <button className="underline">Abmelden</button>
      </form>
    </main>
  );
}
