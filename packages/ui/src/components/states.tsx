import { Icon } from "./ui.js";

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="state state--inset">
      <div className="spinner" />
      <div className="state__hint">{label}</div>
    </div>
  );
}

export function Empty({
  label,
  icon = "tray",
  hint,
}: {
  label: string;
  icon?: string;
  hint?: string;
}) {
  return (
    <div className="state state--inset">
      <div className="state__icon">
        <Icon name={icon} weight="duotone" />
      </div>
      <div className="state__title">{label}</div>
      {hint && <div className="state__hint">{hint}</div>}
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="banner banner--error" role="alert">
      <Icon name="warning-circle" weight="fill" />
      <span>{message}</span>
    </div>
  );
}
