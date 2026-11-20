import Link from "next/link";

export default function Forbidden() {
  return (
    <main className="mx-auto max-w-xl px-6 py-20">
      <h1 className="text-2xl font-semibold">Zugriff verweigert</h1>
      <p className="mt-3">Für diesen Bereich brauchst du ein Admin-Konto.</p>
      <Link href="/dashboard" className="mt-6 inline-block underline">Zurück zur Übersicht</Link>
    </main>
  );
}
