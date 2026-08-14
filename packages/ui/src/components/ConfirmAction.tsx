import { useState } from "react";
import { Icon } from "./ui.js";
import { ErrorState } from "./states.js";

/**
 * Confirmation gate for a destructive action.
 *
 * The consequence is spelled out before the button is armed, because "are you
 * sure?" without saying what happens is not a safeguard.
 */
export function ConfirmAction({
  label,
  detail,
  confirmWord,
  onConfirm,
  onCancel,
}: {
  label: string;
  detail: string;
  /** When set, the user must type this word before the action is armed. */
  confirmWord?: string;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const armed = !confirmWord || typed === confirmWord;

  const run = async () => {
    if (!armed) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="confirm" role="alertdialog" aria-label={label}>
      <div className="confirm__box">
        <div className="confirm__head">
          <Icon name="warning-octagon" weight="fill" />
          <b>{label}</b>
        </div>
        <p className="confirm__detail">{detail}</p>

        {confirmWord && (
          <input
            className="input"
            autoFocus
            placeholder={`Type ${confirmWord} to confirm`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()}
          />
        )}

        {error && <ErrorState message={error} />}

        <div className="confirm__actions">
          <button className="btn btn--sm btn--ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn--sm btn--danger" onClick={run} disabled={busy || !armed}>
            <Icon name={busy ? "spinner" : "check"} /> {busy ? "Working…" : "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
