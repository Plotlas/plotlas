// Unit tier — the shared typing guard (src/ui/keys.ts). It used to be hand-inlined at
// five sites (four ViewerScreen keydown effects + the Lightbox), so widening it meant
// editing five copies (T2-204 review). Centralized + pinned here so its coverage — the
// full set of editable/selection controls — can be trusted at every call site.
import assert from "node:assert/strict";
import test from "node:test";

import { isTypingTarget } from "../src/ui/keys.ts";

test("isTypingTarget: input/textarea/select/contenteditable are typing; other elements are not", () => {
  const el = (tagName: string, isContentEditable = false): EventTarget =>
    ({ tagName, isContentEditable }) as unknown as EventTarget;

  assert.equal(isTypingTarget(el("INPUT")), true, "<input>");
  assert.equal(isTypingTarget(el("TEXTAREA")), true, "<textarea>");
  assert.equal(isTypingTarget(el("SELECT")), true, "<select>");
  assert.equal(isTypingTarget(el("DIV", true)), true, "a contenteditable host");

  assert.equal(isTypingTarget(el("DIV")), false, "a plain div");
  assert.equal(isTypingTarget(el("BUTTON")), false, "a button is a shortcut target, not typing");
  assert.equal(isTypingTarget(null), false, "no target");
  // Non-editable node with no isContentEditable (older jsdom): the guard is `=== true`,
  // not truthy, so undefined must read as NOT typing.
  assert.equal(isTypingTarget({ tagName: "DIV" } as unknown as EventTarget), false, "undefined isContentEditable");
});
