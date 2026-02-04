import { describe, expect, it } from "vitest";
import { pluralize } from "./util";

describe("pluralize", () => {
  it("should pluralize the word", () => {
    expect(pluralize(0, "commit")).toBe("commits");
    expect(pluralize(1, "commit")).toBe("commit");
    expect(pluralize(2, "commit")).toBe("commits");
  });

  it("handles invalid input", () => {
    expect(pluralize(-1, "commit")).toBe("commits");
    expect(pluralize(1.5, "commit")).toBe("commits");
    expect(pluralize(Infinity, "commit")).toBe("commits");
    expect(pluralize(NaN, "commit")).toBe("commits");
    expect(pluralize(1, "")).toBe("");
  });
});
