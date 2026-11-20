export const departments = {
  management: "Geschäftsführung",
  sales: "Vertrieb",
  dispatch: "Dispo",
  accounting: "Buchhaltung",
} as const;
export type Department = keyof typeof departments;
export type TeamGroup = { id: string; name: string };
export type Staff = { id: string; full_name: string; weekly_hours: number; annual_leave_days: number; is_active: boolean; role: "admin" | "employee"; department?: Department | null };

export function DepartmentBadge({ department }: { department?: Department | null }) {
  return <span className={`department-badge department-${department ?? "none"}`}>{department ? departments[department] : "Ohne Abteilung"}</span>;
}

export function DepartmentOptions({ optional = false }: { optional?: boolean }) {
  return <>
    <option value="">{optional ? "Ohne Abteilung" : "Bitte wählen"}</option>
    {Object.entries(departments).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
  </>;
}
