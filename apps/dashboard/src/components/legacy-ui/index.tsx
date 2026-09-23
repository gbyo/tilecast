import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Grid2X2,
  Info,
  List,
  LoaderCircle,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type KeyboardEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";

type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";

export function Button({
  variant = "secondary",
  compact,
  loading,
  children,
  className = "",
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  compact?: boolean;
  loading?: boolean;
}) {
  return (
    <button
      className={`button button--${variant}${compact ? " button--compact" : ""} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <LoaderCircle className="button__spinner" size={16} />}
      <span className={loading ? "button__label--loading" : undefined}>
        {children}
      </span>
    </button>
  );
}

export function IconButton({
  label,
  children,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      className={`icon-button ${className}`.trim()}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(function Input(props, ref) {
  return <input ref={ref} {...props} />;
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea(props, ref) {
  return <textarea ref={ref} {...props} />;
});

export { Select } from "./SignalSelect";
export { ContextMenu, useContextMenu } from "./ContextMenu";
export type { ContextMenuItem } from "./ContextMenu";
export { HoldButton } from "./HoldButton";
export { Popover } from "./Popover";
export type { PopoverMode, PopoverTriggerProps } from "./Popover";
export { MetricTile } from "./MetricTile";
export type { MetricDelta, MetricDirection } from "./MetricTile";
export { FilterBar, FilterChips, useUrlFilters } from "./FilterBar";
export type { FilterDefinition, FilterOption, FilterValues } from "./FilterBar";
export { TimeRangePicker, resolveTimeRange } from "./TimeRangePicker";
export type { ResolvedTimeRange, TimeRangePreset } from "./TimeRangePicker";

export function Field({
  label,
  description,
  error,
  required,
  children,
}: {
  label: string;
  description?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field__label">
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </span>
      {description && <span className="field__hint">{description}</span>}
      {children}
      {error && <span className="field__error">{error}</span>}
    </label>
  );
}

export function Checkbox({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="checkbox-control">
      <input type="checkbox" {...props} />
      <span>{label}</span>
    </label>
  );
}

export function Switch({
  label,
  description,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  description?: string;
}) {
  return (
    <label className="switch-control">
      <input type="checkbox" role="switch" {...props} />
      <span className="switch-control__track" aria-hidden="true">
        <span />
      </span>
      <span className="switch-control__copy">
        <strong>{label}</strong>
        {description && <small>{description}</small>}
      </span>
    </label>
  );
}

export function RadioGroup({
  legend,
  children,
}: {
  legend: string;
  children: ReactNode;
}) {
  return (
    <fieldset className="radio-group">
      <legend>{legend}</legend>
      {children}
    </fieldset>
  );
}

export function Panel({
  className = "",
  ...props
}: HTMLAttributes<HTMLElement>) {
  return <section className={`panel ${className}`} {...props} />;
}

export function SectionHeader({
  title,
  description,
  actions,
  // A panel that sits under a heading of its own is a level deeper than one
  // that opens a page, and the outline a screen reader reads should say so.
  level = 2,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  level?: 2 | 3;
}) {
  const Heading = level === 3 ? "h3" : "h2";
  return (
    <header className="section-header">
      <span>
        <Heading>{title}</Heading>
        {description && <p>{description}</p>}
      </span>
      {actions}
    </header>
  );
}

export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  className = "",
}: {
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={`page-header ${className}`.trim()}>
      <div className="page-header__copy">
        {eyebrow && <div className="page-header__eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </header>
  );
}

export type ViewTab<Value extends string> = {
  value: Value;
  label: ReactNode;
  marker?: ReactNode;
  disabled?: boolean;
};

export function ViewTabs<Value extends string>({
  label,
  value,
  items,
  onValueChange,
  className = "",
}: {
  label: string;
  value: Value;
  items: readonly ViewTab<Value>[];
  onValueChange: (value: Value) => void;
  className?: string;
}) {
  function moveFocus(
    event: KeyboardEvent<HTMLButtonElement>,
    direction: -1 | 1,
  ) {
    const buttons = Array.from(
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      ) ?? [],
    );
    const current = buttons.indexOf(event.currentTarget);
    if (current < 0 || buttons.length < 2) return;
    event.preventDefault();
    buttons[(current + direction + buttons.length) % buttons.length]?.focus();
  }

  return (
    <nav className={`view-tabs ${className}`.trim()} aria-label={label}>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-current={value === item.value ? "page" : undefined}
          disabled={item.disabled}
          onClick={() => onValueChange(item.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") moveFocus(event, -1);
            if (event.key === "ArrowRight") moveFocus(event, 1);
            if (event.key === "Home" || event.key === "End") {
              const buttons = Array.from(
                event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                  "button:not(:disabled)",
                ) ?? [],
              );
              event.preventDefault();
              buttons[event.key === "Home" ? 0 : buttons.length - 1]?.focus();
            }
          }}
        >
          <span>{item.label}</span>
          {item.marker && <small>{item.marker}</small>}
        </button>
      ))}
    </nav>
  );
}

export function Pagination({
  label,
  previous,
  next,
  previousDisabled,
  nextDisabled,
  status,
  className = "",
}: {
  label: string;
  previous: () => void;
  next: () => void;
  previousDisabled?: boolean;
  nextDisabled?: boolean;
  status?: ReactNode;
  className?: string;
}) {
  return (
    <nav className={`pagination ${className}`.trim()} aria-label={label}>
      <Button
        variant="secondary"
        disabled={previousDisabled}
        onClick={previous}
      >
        Previous
      </Button>
      {status && <span className="pagination__status">{status}</span>}
      <Button variant="secondary" disabled={nextDisabled} onClick={next}>
        Next
      </Button>
    </nav>
  );
}

export function ViewToggle({
  value,
  onValueChange,
  label = "View",
}: {
  value: "grid" | "list";
  onValueChange: (value: "grid" | "list") => void;
  label?: string;
}) {
  return (
    <span className="view-toggle" aria-label={label} role="group">
      <button
        type="button"
        aria-label="Grid view"
        aria-pressed={value === "grid"}
        onClick={() => onValueChange("grid")}
      >
        <Grid2X2 size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="List view"
        aria-pressed={value === "list"}
        onClick={() => onValueChange("list")}
      >
        <List size={16} aria-hidden="true" />
      </button>
    </span>
  );
}

export function ToggleGroup<Value extends string>({
  label,
  value,
  items,
  onValueChange,
  className = "",
}: {
  label: string;
  value: Value;
  items: readonly { value: Value; label: ReactNode; disabled?: boolean }[];
  onValueChange: (value: Value) => void;
  className?: string;
}) {
  return (
    <div
      className={`toggle-group ${className}`.trim()}
      role="group"
      aria-label={label}
    >
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={value === item.value}
          disabled={item.disabled}
          onClick={() => onValueChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function Toolbar(props: HTMLAttributes<HTMLDivElement>) {
  return <div className="toolbar" role="toolbar" {...props} />;
}

type NoticeVariant = "info" | "success" | "warning" | "danger" | "neutral";
const noticeIcons = {
  info: Info,
  success: CheckCircle2,
  warning: TriangleAlert,
  danger: AlertCircle,
  neutral: Circle,
};
export function Notice({
  variant = "neutral",
  title,
  children,
  action,
}: {
  variant?: NoticeVariant;
  title?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  const Icon = noticeIcons[variant];
  return (
    <div
      className={`notice notice--${variant}`}
      role={variant === "danger" ? "alert" : "status"}
    >
      <Icon size={18} />
      <span>
        {title && <strong>{title}</strong>}
        <span>{children}</span>
      </span>
      {action}
    </div>
  );
}

type StatusTone = "success" | "info" | "warning" | "danger" | "neutral";
export function StatusDot({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: StatusTone;
}) {
  return (
    <span className={`status-dot-label status-dot-label--${tone}`}>
      <span aria-hidden="true" />
      {label}
    </span>
  );
}
export function StatusBadge({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: StatusTone;
}) {
  return (
    <span className={`status-chip status-chip--${tone}`}>
      <Circle size={8} fill="currentColor" />
      {label}
    </span>
  );
}

export function EmptyState({
  title,
  message,
  action,
  icon,
  className = "",
}: {
  title: string;
  message: string;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`empty-state ${className}`.trim()}>
      {icon && <span className="empty-state__icon">{icon}</span>}
      <h2>{title}</h2>
      <p>{message}</p>
      {action}
    </div>
  );
}

export function Dialog({
  open,
  title,
  children,
  onClose,
  className = "",
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`dialog ${className}`.trim()}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
    >
      <header>
        <h2 id={titleId}>{title}</h2>
        <IconButton label="Close" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </header>
      {children}
    </dialog>
  );
}

export function Drawer({
  title,
  eyebrow,
  children,
  footer,
  onClose,
  closeLabel = "Close details",
  className = "",
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  closeLabel?: string;
  className?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current
      ?.querySelector<HTMLElement>("button, [href], input, select, textarea")
      ?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      ref.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  return (
    <div className="drawer-layer">
      <button
        type="button"
        className="drawer-backdrop"
        aria-label={closeLabel}
        onClick={onClose}
      />
      <aside
        ref={ref}
        className={`drawer ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleKeyDown}
      >
        <header className="drawer__header">
          <span>
            {eyebrow && <small>{eyebrow}</small>}
            <h2 id={titleId}>{title}</h2>
          </span>
          <IconButton label={closeLabel} onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </IconButton>
        </header>
        <div className="drawer__body">{children}</div>
        {footer && <footer className="drawer__footer">{footer}</footer>}
      </aside>
    </div>
  );
}

export function TableContainer(props: HTMLAttributes<HTMLDivElement>) {
  return <div className="table-container" {...props} />;
}

export function Skeleton({ width = "100%" }: { width?: string }) {
  return <span className="skeleton" style={{ width }} aria-hidden="true" />;
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span className="spinner" role="status">
      <span className="visually-hidden">{label}</span>
    </span>
  );
}
