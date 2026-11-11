import { describe, expect, it } from "vitest";
import { formatAgo } from "./format";

describe("how long ago", () => {
  it("says how long ago in plain words", () => {
    const now = new Date(2026, 10, 11, 12);
    const back = (days: number, hour = 12) => new Date(2026, 10, 11 - days, hour);
    expect(formatAgo(back(0, 8), now)).toBe("today");
    expect(formatAgo(back(1, 23), now)).toBe("yesterday");
    expect(formatAgo(back(5), now)).toBe("5 days ago");
    expect(formatAgo(back(13), now)).toBe("13 days ago");
    expect(formatAgo(back(14), now)).toBe("2 weeks ago");
    expect(formatAgo(back(24), now)).toBe("3 weeks ago");
    expect(formatAgo(back(70), now)).toBe("2 months ago");
  });
});
