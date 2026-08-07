// Keyboard helpers shared across the viewer chrome — ViewerScreen's global
// shortcuts (Esc / Enter / "/" / `) and the Lightbox's modal keys. Extracted so
// the "is the user typing?" guard lives in ONE place: it had been hand-inlined at
// five sites (the four ViewerScreen keydown effects + the Lightbox), which is why
// widening its coverage used to mean editing five copies (T2-204 review).

/** True when a keyboard event originates from a control where the keystroke is
 *  text/selection the user is entering, so a global shortcut must NOT hijack it.
 *  Covers `<input>`, `<textarea>`, `<select>`, and any contenteditable host — the
 *  full set, in one place, so the guard can't be right at one call site and stale
 *  at another. (`isContentEditable` is `undefined` on non-editable nodes and in
 *  older jsdom, so the explicit `=== true` keeps it a no-op there.) */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (el === null) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}
