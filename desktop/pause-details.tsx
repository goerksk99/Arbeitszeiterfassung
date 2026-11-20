import { Coffee } from "lucide-react";
import { berlinDate } from "../lib/work-time";
import { date, time } from "./time-display";

export type BreakInterval = { id: string; entry_id: string; user_id: string; started_at: string; ended_at: string | null };

export function PauseDetails({ breaks, className }: { breaks: BreakInterval[]; className?: string }) {
  if (!breaks.length) return null;
  return <ul className={className} aria-label="Gestempelte Pausen">
    {breaks.map((item) => {
      const start = Date.parse(item.started_at);
      const crossesDay = item.ended_at && berlinDate(item.started_at) !== berlinDate(item.ended_at);
      return <li key={item.id}><Coffee size={14} aria-hidden="true" />{time.format(start)} – {item.ended_at
        ? `${crossesDay ? date.format(Date.parse(item.ended_at)) + ", " : ""}${time.format(Date.parse(item.ended_at))}`
        : "läuft"}</li>;
    })}
  </ul>;
}
