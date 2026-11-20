import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";

export function Modal({ title, onClose, busy = false, children }: {
  title: string; onClose: () => void; busy?: boolean; children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="app-modal" aria-labelledby={heading}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="modal-heading">
      <h2 id={heading}>{title}</h2>
      <button type="button" aria-label="Schließen" disabled={busy} onClick={onClose}><X size={21} aria-hidden="true" /></button>
    </div>
    <div className="modal-content">{children}</div>
  </dialog>;
}
