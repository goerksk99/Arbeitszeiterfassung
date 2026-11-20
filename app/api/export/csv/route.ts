import { reportCsv, type MonthlyReport } from "../../../../lib/monthly-report";
import { createClient } from "../../../../lib/supabase/server";
import { berlinDate } from "../../../../lib/work-time";

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response("Anmeldung erforderlich.", { status: 401 });
  const { data: profile } = await supabase.from("profiles")
    .select("role, is_active").eq("id", user.id).maybeSingle();
  if (profile?.role !== "admin" || !profile.is_active) return new Response("Zugriff verweigert.", { status: 403 });

  const params = new URL(request.url).searchParams;
  const period = params.get("month") ?? berlinDate(new Date().toISOString()).slice(0, 7);
  const member = params.get("user_id");
  if (!/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(period) ||
    (member && !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(member))) {
    return new Response("Ungültiger Monat oder Mitarbeiter.", { status: 400 });
  }
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5));
  let query = supabase.from("profiles").select("id, full_name").order("full_name");
  if (member) query = query.eq("id", member);
  const { data: members, error } = await query;
  if (error) return new Response("Die Mitarbeiterliste konnte nicht geladen werden.", { status: 502 });
  if (member && !members.length) return new Response("Profil nicht gefunden.", { status: 404 });

  const results = await Promise.all(members.map(async (person) => {
    const report = await supabase.rpc("read_monthly_report", {
      member_id: person.id, report_year: year, report_month: month,
    });
    return { ...report, name: person.full_name };
  }));
  if (results.some((result) => result.error)) return new Response("Die Berichte konnten nicht geladen werden.", { status: 502 });

  return new Response(reportCsv(results.map((result) => ({ ...(result.data as MonthlyReport), full_name: result.name }))), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="arbeitszeiterfassung-${period}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
