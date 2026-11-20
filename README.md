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
Das Paket ist unsigniert. Für ein bestehendes Supabase-Projekt die unten
aufgeführten Schritte zur Aktivierung ausführen. Die Übersicht ordnet
Buchungen nach ihrem Berliner Startdatum zu und nutzt abgeschlossene
Vormonate für den Saldoübertrag.

Das kleine ZIP in `downloads/` verwendet denselben App-Build und lädt
Electron beim ersten Start von GitHub. Zum Aktualisieren die App
schließen und das ZIP in denselben entpackten Ordner kopieren.

## Windows-Version 0.3.0 aktivieren und testen

1. Im vorhandenen Supabase-Projekt unter **SQL Editor → New query** genau die
   [neue Migration](supabase/migrations/20261120020000_calendar_admin_reports.sql)
   vollständig ausführen. Bei Erstinstallation alle Migrationen in ihrer
   Dateireihenfolge anwenden.
2. Für **Mitarbeiterkonto anlegen** die Edge-Funktion `manage-employee`
   im selben Supabase-Projekt bereitstellen. In **Edge Functions →
   Deploy a new function → Via Editor** den vollständigen
   [Funktionscode](supabase/functions/manage-employee/index.ts) als
   `index.ts` einfügen und als `manage-employee` bereitstellen. In den
   Einstellungen der Funktion **Verify JWT with legacy secret** deaktivieren.
   Die Funktion verifiziert die Anmeldung selbst über Supabase Auth und prüft
   zusätzlich aktiven Adminstatus. Supabase stellt der Funktion die benötigten
   Backend-Variablen bereit.
   Mit verknüpfter Supabase CLI geht es über
   `supabase functions deploy manage-employee --no-verify-jwt`.
3. App schließen, das [Windows-Startpaket](downloads/Arbeitszeiterfassung-Windows-Startpaket.zip)
   im bestehenden App-Ordner entpacken und die Dateien ersetzen.
   Dann `Arbeitszeiterfassung-starten.cmd` starten.

Die Admin-Konsole legt Mitarbeiterkonten mit Startpasswort an. Das Passwort
persönlich weitergeben und vom Mitarbeiter in der App ändern lassen.

### Fachlicher Testablauf mit Testdaten

1. Als Admin anmelden, ein fiktives Mitarbeiterkonto anlegen und bei Bedarf
   dessen Wochenstunden und Jahresurlaub speichern.
2. Als Mitarbeiter ein- und ausstempeln, optional Pause und Notiz eintragen.
   Eine Buchung nachtragen oder korrigieren und den Status „Zur Prüfung“
   kontrollieren.
3. Im Mitarbeiterkonto Urlaub, Krankheit, Zeitausgleich und Sonstiges
   beantragen. Monats- und Jahresansicht und die vier Filter prüfen.
4. Als Admin die Anträge prüfen und genehmigen oder ablehnen. Bei einer
   vergessenen Ausstempelzeit eine Endzeit mit Begründung erfassen.
   Den Kalender nochmals als Mitarbeiter öffnen und prüfen, dass eigene
   Krankmeldungen sichtbar sind und fremde ausgeblendet werden.
5. Für einen vergangenen Monat erst offene Vorgänge abschließen, dann in
   **Monatsberichte** den Monatsabschluss bestätigen. Den Saldo im Folgemonat
   als Vortrag prüfen. Eine nachträgliche Änderung im gesperrten Monat
   als Mitarbeiter versuchen.
6. Je einen laufenden und einen abgeschlossenen Bericht als CSV exportieren
   und die Druckansicht ansehen.

Ein Abschluss ist ab dem ersten Tag des Folgemonats möglich. Nach dem ersten
Abschluss folgen weitere Monate in chronologischer Reihenfolge, damit der
Übertrag vollständig bleibt. Zeit über Mitternacht gehört zum Berliner
Startdatum. Ganztägige Abwesenheiten zählen auf Montag bis Freitag.
