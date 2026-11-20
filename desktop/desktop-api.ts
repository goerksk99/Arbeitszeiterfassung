export type ClockAction = "in" | "out" | "pause" | "resume";
export type TrayState = {
  status: "signed-out" | "loading" | "stopped" | "working" | "paused";
  canPause: boolean;
  busy: boolean;
};

declare global {
  interface Window {
    desktop?: {
      printReport: () => void;
      saveMonthlyPdf: (month: string) => Promise<boolean>;
      setTrayState: (state: TrayState) => void;
      onTrayAction: (listener: (action: ClockAction) => void) => () => void;
      showClockProblem: () => void;
    };
  }
}
