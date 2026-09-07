// Shared setup for React-Testing-Library component tests. Import this at
// the top of any `*.test.tsx` file that renders a component (alongside a
// `// @vitest-environment jsdom` docblock at the very top of that file).
//
// Deliberately NOT wired into vitest.config.ts's global `setupFiles` — the
// project's default test environment stays "node" for the existing
// (larger) suite of pure-logic/live-DB tests, and this import is opt-in
// per file so only actual component tests pay for jsdom + RTL setup.
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// This project doesn't run vitest in `globals: true` mode, so Testing
// Library's own automatic-cleanup detection (which looks for a global
// `afterEach`) never fires — without this, a render from one `it` block
// leaks into the next within the same file.
afterEach(cleanup);

// jsdom implements neither the Pointer Events capture methods nor
// scrollIntoView — Radix UI's Select/Combobox (and similar) primitives call
// these unconditionally on open/interact, so without a stub any test that
// actually opens one throws "target.hasPointerCapture is not a function"
// (Pass 7 — first hit writing ReassignContactDialog's own component test).
// No-op stubs are all any test needs; nothing here asserts real capture/
// scroll behavior.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// jsdom also has no ResizeObserver at all — Radix's Popper-positioned
// primitives (Tooltip/Select/Popover content) construct one as soon as
// they actually mount into the DOM (e.g. a Tooltip opened by clicking its
// trigger), which otherwise throws "ResizeObserver is not defined" (Pass
// 13 — first hit clicking a Tooltip-wrapped Reset button in
// flight-segment-duration.test.tsx). Same no-op-stub precedent as the
// pointer-capture/scrollIntoView stubs above — nothing here asserts real
// resize-observation behavior.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// Automated accessibility scans (axe-core, via the `axe` function
// exported directly from "vitest-axe") are done in individual test files
// by asserting `expect(results.violations).toEqual([])` rather than
// registering vitest-axe's own `toHaveNoViolations()` custom matcher here
// — that matcher's ambient type augmentation targets a `Vi.Assertion`
// shape this project's vitest 4.x no longer exposes (the package is an
// old, lightly-maintained jest-axe fork), so it fails to typecheck even
// though it registers fine at runtime. Asserting directly on
// `results.violations` needs no type augmentation at all and is exactly
// as strong a check. See flight-segment-editor-accessibility.test.tsx for
// the actual usage pattern.
