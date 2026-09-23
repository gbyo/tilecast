import { Check, ChevronDown } from "lucide-react";
import {
  Children,
  Fragment,
  forwardRef,
  isValidElement,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { fixedPositionOffset, overlayPortalTarget } from "./overlayPortal";

type SignalOption = {
  value: string;
  label: ReactNode;
  text: string;
  disabled: boolean;
  group?: string;
};

function optionText(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (Array.isArray(value)) return value.map(optionText).join("");
  if (isValidElement<{ children?: ReactNode }>(value))
    return optionText(value.props.children);
  return "";
}

function collectOptions(children: ReactNode, group?: string): SignalOption[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement(child)) return [];
    if (child.type === Fragment)
      return collectOptions(
        (child as ReactElement<{ children?: ReactNode }>).props.children,
        group,
      );
    if (child.type === "optgroup") {
      const element = child as ReactElement<{
        children?: ReactNode;
        label?: string;
        disabled?: boolean;
      }>;
      return collectOptions(element.props.children, element.props.label).map(
        (option) => ({
          ...option,
          disabled: option.disabled || Boolean(element.props.disabled),
        }),
      );
    }
    if (child.type !== "option") return [];
    const element = child as ReactElement<{
      children?: ReactNode;
      value?: string | number;
      disabled?: boolean;
    }>;
    const text = optionText(element.props.children);
    return [
      {
        value: String(element.props.value ?? text),
        label: element.props.children,
        text,
        disabled: Boolean(element.props.disabled),
        group,
      },
    ];
  });
}

export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement>
>(function SignalSelect(
  {
    children,
    className = "",
    disabled,
    value,
    defaultValue,
    onChange,
    onBlur,
    onFocus,
    id,
    style,
    "aria-label": ariaLabel,
    "aria-labelledby": ariaLabelledBy,
    ...nativeProps
  },
  forwardedRef,
) {
  const generatedId = useId();
  const controlId = id ?? `signal-select-${generatedId}`;
  const listboxId = `${controlId}-listbox`;
  const nativeRef = useRef<HTMLSelectElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const options = useMemo(() => collectOptions(children), [children]);
  const [internalValue, setInternalValue] = useState(() =>
    String(defaultValue ?? options[0]?.value ?? ""),
  );
  const selectedValue = String(value ?? internalValue);
  const selected =
    options.find((option) => option.value === selectedValue) ?? options[0];
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>();
  const [menuHost, setMenuHost] = useState<HTMLElement>();

  useImperativeHandle(forwardedRef, () => nativeRef.current!, []);

  const positionMenu = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const bounds = trigger.getBoundingClientRect();
    // Resolved with the position: a menu that opens inside a modal dialog has
    // to live in the top layer with it, or it paints behind the dialog and
    // cannot be clicked. The offset corrects for a host that is itself the
    // containing block for fixed-position children.
    const host = overlayPortalTarget(trigger);
    const offset = fixedPositionOffset(host);
    setMenuHost(host);
    const viewportGap = 8;
    const availableBelow = window.innerHeight - bounds.bottom - viewportGap;
    const availableAbove = bounds.top - viewportGap;
    const maxHeight = Math.max(
      120,
      Math.min(320, Math.max(availableBelow, availableAbove)),
    );
    const openAbove = availableBelow < 180 && availableAbove > availableBelow;
    const width = Math.max(bounds.width, 180);
    const left = Math.min(
      Math.max(viewportGap, bounds.left),
      window.innerWidth - width - viewportGap,
    );
    setMenuStyle({
      position: "fixed",
      left: left - offset.left,
      width,
      maxHeight,
      ...(openAbove
        ? { bottom: window.innerHeight - bounds.top + 4 - offset.bottom }
        : { top: bounds.bottom + 4 - offset.top }),
    });
  };

  useLayoutEffect(() => {
    if (!open) return;
    positionMenu();
    const close = () => setOpen(false);
    const closeOnExternalScroll = (event: Event) => {
      const target = event.target;
      const listbox = document.getElementById(listboxId);
      if (target instanceof Node && listbox?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", closeOnExternalScroll, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", closeOnExternalScroll, true);
    };
  }, [listboxId, open]);

  useEffect(() => {
    if (!open) return;
    const selectedIndex = Math.max(
      0,
      options.findIndex((option) => option.value === selectedValue),
    );
    setActiveIndex(selectedIndex);
    requestAnimationFrame(() => optionRefs.current[selectedIndex]?.focus());
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !document.getElementById(listboxId)?.contains(target)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [listboxId, open, options, selectedValue]);

  const choose = (option: SignalOption) => {
    if (option.disabled) return;
    setInternalValue(option.value);
    const native = nativeRef.current;
    if (native) {
      // Use the platform setter so React observes the synthetic native change.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const setter = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        "value",
      )?.set;
      if (setter) Reflect.apply(setter, native, [option.value]);
      native.dispatchEvent(new Event("change", { bubbles: true }));
    }
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const move = (direction: 1 | -1) => {
    if (!options.length) return;
    let next = activeIndex;
    do next = (next + direction + options.length) % options.length;
    while (options[next]?.disabled && next !== activeIndex);
    setActiveIndex(next);
    optionRefs.current[next]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (!open) {
      if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === "Escape" || event.key === "Tab") {
      setOpen(false);
      if (event.key === "Escape") {
        event.preventDefault();
        triggerRef.current?.focus();
      }
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      const next = options.findIndex((option) => !option.disabled);
      setActiveIndex(Math.max(0, next));
      optionRefs.current[Math.max(0, next)]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      let next = options.length - 1;
      while (next > 0 && options[next]?.disabled) next -= 1;
      setActiveIndex(Math.max(0, next));
      optionRefs.current[Math.max(0, next)]?.focus();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const option = options[activeIndex];
      if (option) choose(option);
    }
  };

  return (
    <span className={`signal-select ${className}`} style={style}>
      {/* The trigger is rendered before the hidden native select on purpose. Studio's fields wrap
          their control in a <label>, and a label names its *first* labelable descendant. With the
          native select first, the label's text went to an aria-hidden element and the visible
          trigger was left with no accessible name — so nearly every select in the app was
          unnamed to a screen reader. Putting the button first hands it the label instead, and
          also makes clicking the label open the menu. The native select stays for form
          semantics and change events; it is visually hidden and never tab-focusable. */}
      <button
        ref={triggerRef}
        id={controlId}
        type="button"
        className="signal-select__trigger"
        role="combobox"
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleKeyDown}
      >
        <span>{selected?.label ?? "Select an option"}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      <select
        {...nativeProps}
        ref={nativeRef}
        className="signal-select__native"
        value={selectedValue}
        disabled={disabled}
        tabIndex={-1}
        aria-hidden="true"
        onChange={onChange}
        onBlur={onBlur}
        onFocus={onFocus}
      >
        {children}
      </select>
      {open &&
        menuStyle &&
        menuHost &&
        createPortal(
          <div
            id={listboxId}
            className="signal-select__menu"
            role="listbox"
            aria-labelledby={ariaLabelledBy ?? controlId}
            style={menuStyle}
            onKeyDown={handleKeyDown}
          >
            {options.map((option, index) => {
              const showGroup =
                option.group && options[index - 1]?.group !== option.group;
              return (
                <Fragment
                  key={`${option.group ?? ""}-${option.value}-${index}`}
                >
                  {showGroup && (
                    <div className="signal-select__group">{option.group}</div>
                  )}
                  <button
                    ref={(element) => {
                      optionRefs.current[index] = element;
                    }}
                    type="button"
                    className={index === activeIndex ? "is-active" : ""}
                    role="option"
                    aria-selected={option.value === selectedValue}
                    disabled={option.disabled}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => choose(option)}
                  >
                    <span>{option.label}</span>
                    {option.value === selectedValue && (
                      <Check size={15} aria-hidden="true" />
                    )}
                  </button>
                </Fragment>
              );
            })}
          </div>,
          menuHost,
        )}
    </span>
  );
});
