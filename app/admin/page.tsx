import Link from "next/link";
import { requireProfile } from "../../lib/auth";

export default async function AdminPage() {
  await requireProfile("admin");

  return (
    <main className="mx-auto max-w-3xl px-6 py-20">
      <h1 className="text-3xl font-semibold">Admin-Bereich</h1>
      <Link href="/dashboard" className="mt-5 inline-block underline">Zurück zur Übersicht</Link>
    </main>
  );
}
