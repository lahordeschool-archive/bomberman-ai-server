import { type ReactNode, useEffect, useId, useRef } from 'react';

/** Native modal dialog: focus trapping, Escape and the backdrop come from the browser. */
export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose(): void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className="modal"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      {open ? (
        <div className="modal-body">
          <h2 id={titleId}>{title}</h2>
          {children}
        </div>
      ) : null}
    </dialog>
  );
}
