import { describe, it, expect } from "vitest";
import { inProcessPollerDisabled } from "../poller-config";

// DISABLE_IN_PROCESS_POLLER is an opt-out: unset (or anything unrecognised) leaves the in-process task-due poller running exactly as before, because
// the VPS deployment relies on it. Only an explicit truthy value turns it off.
describe("inProcessPollerDisabled", () => {
  it("is false when the variable is unset, empty or unrecognised - the default is unchanged", () => {
    for (const v of [undefined, "", " ", "false", "0", "no", "off", "disable", "maybe"]) {
      expect(inProcessPollerDisabled({ DISABLE_IN_PROCESS_POLLER: v }), String(v)).toBe(false);
    }
    expect(inProcessPollerDisabled({})).toBe(false);
  });

  it("is true for an explicit truthy value, whatever the case or surrounding whitespace", () => {
    for (const v of ["true", "TRUE", " True ", "1", "yes", "YES", "on", "On"]) {
      expect(inProcessPollerDisabled({ DISABLE_IN_PROCESS_POLLER: v }), v).toBe(true);
    }
  });
});
