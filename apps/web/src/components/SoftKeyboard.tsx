import { forwardRef, useImperativeHandle, useRef, type KeyboardEvent, type PointerEvent } from "react";
import type { SpecialKey } from "../player/protocol";

export type SoftKeyboardHandle = {
  open: () => void;
  close: () => void;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onType: (text: string) => void;
  onKey: (key: SpecialKey) => void;
};

// The hidden input always holds this text so Backspace has something to delete.
const SENTINEL = "~~";

const EXTRA_KEYS: { key: SpecialKey; label: string; wide?: boolean }[] = [
  { key: "esc", label: "Esc" },
  { key: "tab", label: "Tab" },
  { key: "left", label: "←" },
  { key: "up", label: "↑" },
  { key: "down", label: "↓" },
  { key: "right", label: "→" },
  { key: "f1", label: "F1" },
  { key: "f2", label: "F2" },
  { key: "f3", label: "F3" },
  { key: "f4", label: "F4" },
  { key: "f5", label: "F5" },
  { key: "f10", label: "F10" },
  { key: "backspace", label: "⌫" },
  { key: "enter", label: "Enter", wide: true },
];

const KEYDOWN_MAP: Record<string, SpecialKey> = {
  Escape: "esc",
  Tab: "tab",
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  Delete: "delete",
  Enter: "enter",
  F1: "f1",
  F2: "f2",
  F3: "f3",
  F4: "f4",
  F5: "f5",
  F6: "f6",
  F7: "f7",
  F8: "f8",
  F9: "f9",
  F10: "f10",
};

/**
 * Bridges the phone's own keyboard to the game. A hidden text input receives what is typed; each
 * change is compared with the previous value, so word predictions/autocorrect (which replace whole
 * words) turn into the right Backspaces and characters. Tapping the toolbar button again, or the
 * phone's own "hide keyboard" control, collapses it.
 */
export const SoftKeyboard = forwardRef<SoftKeyboardHandle, Props>(function SoftKeyboard(
  { open, onOpenChange, onType, onKey },
  ref,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  const prevRef = useRef(SENTINEL);
  const composingRef = useRef(false);

  const reset = () => {
    const input = inputRef.current;
    if (!input) return;
    input.value = SENTINEL;
    prevRef.current = SENTINEL;
    input.setSelectionRange(SENTINEL.length, SENTINEL.length);
  };

  useImperativeHandle(ref, () => ({
    open: () => {
      reset();
      inputRef.current?.focus({ preventScroll: true });
    },
    close: () => inputRef.current?.blur(),
  }));

  const onInput = () => {
    const input = inputRef.current!;
    const next = input.value;
    const prev = prevRef.current;
    let i = 0;
    while (i < prev.length && i < next.length && prev[i] === next[i]) i++;
    for (let d = prev.length - i; d > 0; d--) onKey("backspace");
    const inserted = next.slice(i);
    if (inserted) onType(inserted);
    prevRef.current = next;
    // Top the sentinel back up / keep the buffer short, but never mid-word (that confuses predictive keyboards).
    if (!composingRef.current && (next.length < SENTINEL.length || next.length > 40)) reset();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const special = KEYDOWN_MAP[e.key];
    if (!special || e.nativeEvent.isComposing) return;
    e.preventDefault();
    onKey(special);
  };

  // Keep focus in the hidden input when tapping the extra keys.
  const keepFocus = (e: PointerEvent) => e.preventDefault();

  return (
    <>
      <input
        ref={inputRef}
        className="soft-kb-input"
        type="text"
        inputMode="text"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="enter"
        aria-label="Type into the game"
        defaultValue={SENTINEL}
        onInput={onInput}
        onKeyDown={onKeyDown}
        onCompositionStart={() => (composingRef.current = true)}
        onCompositionEnd={() => {
          composingRef.current = false;
        }}
        onFocus={() => onOpenChange(true)}
        onBlur={() => onOpenChange(false)}
      />
      {open && (
        <div className="soft-kb-bar" role="toolbar" aria-label="Extra keys">
          {EXTRA_KEYS.map((k) => (
            <button
              key={k.key}
              type="button"
              className={`kb-key ${k.wide ? "wide" : ""}`}
              onPointerDown={keepFocus}
              onClick={() => onKey(k.key)}
            >
              {k.label}
            </button>
          ))}
          <button
            type="button"
            className="kb-key hide"
            onPointerDown={keepFocus}
            onClick={() => inputRef.current?.blur()}
            aria-label="Hide keyboard"
          >
            ⌄
          </button>
        </div>
      )}
    </>
  );
});
