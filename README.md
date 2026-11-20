# Arbeitszeiterfassung

## Lokal entwickeln

Voraussetzung ist Node.js 22 oder neuer. Im vorhandenen Checkout ausführen.

```sh
npm ci
npm test
npm run build
npm run dev
```

Für die Anmeldung `.env.example` als `.env.local` kopieren und die Projekt-URL sowie den Publishable Key aus den API-Einstellungen eintragen. Für lokale Supabase-Projekte kann der öffentliche Anon-Key als Ersatz für den Publishable Key dienen. In der Codex-Cloud mit dem konfigurierten HTTPS-Proxy den Entwicklungsserver mit `NODE_USE_ENV_PROXY=1 npm run dev` starten.

Unter `/login` mit dem angelegten Supabase-Konto anmelden. Die Übersicht erfordert ein aktives Profil. Der Bereich `/admin` erfordert die Rolle `admin`.

## Datenbank

Mit Supabase CLI und Docker lässt sich die Migration über `supabase start` lokal anwenden. Für ein gehostetes Projekt die Migration über eine verknüpfte Supabase CLI mit `supabase db push` anwenden. Im gehosteten Projekt die öffentliche Registrierung in den Auth-Einstellungen deaktivieren. Das erste Auth-Konto über die Supabase-Administration anlegen und seine UUID in `public.profiles` mit Rolle `admin` eintragen. Weitere Profile werden in späteren Meilensteinen über die Admin-Verwaltung eingerichtet.

Mitarbeitende können abgeschlossene Zeitbuchungen über begründete Korrekturanträge korrigieren. Monatsabschlüsse sind abgeleitete Auswertungen. Mitarbeitende lesen nur ihre eigenen Summen und ändern die zugrunde liegenden Buchungen bis zur Sperre. Der Teamkalender liefert fremde genehmigte Abwesenheiten ohne Notizen und blendet fremde Krankmeldungen aus.

Die Zeitlogik verwendet Berliner Kalendertage und reale verstrichene Minuten. Die Monatsberechnung verteilt die Wochenarbeitszeit gleichmäßig auf Montag bis Freitag und behandelt genehmigtes Sonstiges als bezahlt. Ein Zeitausgleichstag behält sein Tagessoll und belastet den Saldo damit einmal. Feiertage sind in diesem ersten Meilenstein nur über bezahlte Abwesenheiten abbildbar.

## Kostenloser Browser-Test auf Render

In Render unter **New → Blueprint** das GitHub-Repository verbinden. Die Datei
`render.yaml` legt einen Node.js-Webdienst im Tarif **Free** in Frankfurt an.
Beim Import die zwei Werte aus `.env.local` in die gleichnamigen
Umgebungsvariablen eintragen. Die URL und der Publishable Key sind in den
Supabase-API-Einstellungen zu finden. Der Blueprint benötigt keine weitere
Datenbank und kein Datenbankpasswort.

Nach dem Deployment die von Render angezeigte Adresse öffnen. Der Start leitet
zur Anmeldung weiter. Nach Inaktivität kann der erste Aufruf etwas dauern.

## Windows-App mit Supabase Free

Die Windows-App ist ein portables Testpaket für Windows x64. Das ZIP komplett
entpacken und `Arbeitszeiterfassung.exe` im entpackten Ordner öffnen. Zum
Anmelden das vorhandene Supabase-Testkonto verwenden. Eine Internetverbindung
ist erforderlich. Die App speichert die Anmeldesitzung nur bis zum Schließen.

Zum erneuten Packen mit Node.js 24, `.env.local` und dem öffentlichen
Supabase Publishable Key:

```sh
npm ci
npm run desktop:package
```

Das Ergebnis liegt in `.desktop/release/Arbeitszeiterfassung-win32-x64`.
Das Paket ist unsigniert. Es enthält den Desktop-Login und den Profilabruf.
