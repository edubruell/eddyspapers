import { describe, it, expect } from "vitest";

// The agentic_frontend has no unit-test runner (only Playwright e2e), so the pure
// export builders are tested from the backend vitest suite via relative import.
// exports.js is dependency-free ESM, so it resolves cleanly here.
// @ts-expect-error — plain JS module, no types
import { buildMarkdown, sourcesHtml, papersList } from "../../../frontends/agentic/src/lib/exports.js";

const normalPaper = {
  handle: "RePEc:aaa:bbb:1",
  title: "On Things",
  authors: ["Doe, Jane", "Roe, Richard"],
  year: 2021,
  journal: "Journal of Things",
  abstract: "A study of things.",
};

describe("papersList", () => {
  it("returns [] for null/undefined", () => {
    expect(papersList(null)).toEqual([]);
    expect(papersList(undefined)).toEqual([]);
  });
  it("returns object values as an array", () => {
    expect(papersList({ a: 1, b: 2 })).toEqual([1, 2]);
  });
});

describe("buildMarkdown", () => {
  it("renders a normal paper into a numbered Sources entry", () => {
    const md = buildMarkdown("Review body.", { a: normalPaper });
    expect(md).toContain("Review body.");
    expect(md).toContain("## Sources");
    expect(md).toContain(
      '1. Doe, Jane, Roe, Richard (2021) "On Things", Journal of Things',
    );
    expect(md).toContain("`RePEc:aaa:bbb:1`");
    expect(md).toContain("Abstract: A study of things.");
    expect(md).toContain("---");
  });

  it("handles missing authors/year/journal/abstract gracefully", () => {
    const md = buildMarkdown("", { a: { handle: "h:1", title: "Bare" } });
    expect(md).toContain('1. Unknown author "Bare"');
    expect(md).not.toContain("(undefined)");
    expect(md).not.toContain("Abstract:");
    // No year/journal -> no parens, no trailing comma after the title quote
    expect(md).toContain('"Bare"\n');
  });

  it("returns just the review (no Sources) when there are no papers", () => {
    expect(buildMarkdown("Only review.", {})).toBe("Only review.\n");
    expect(buildMarkdown("Only review.", null)).toBe("Only review.\n");
  });

  it("returns empty string when both review and papers are empty", () => {
    expect(buildMarkdown("", {})).toBe("");
    expect(buildMarkdown(null, null)).toBe("");
  });

  it("renders Sources only when synthesis is empty but papers exist", () => {
    const md = buildMarkdown("", { a: normalPaper });
    expect(md.startsWith("## Sources")).toBe(true);
    expect(md).not.toContain("---");
  });

  it("collapses internal whitespace in title and abstract to single spaces", () => {
    const md = buildMarkdown("", {
      a: {
        handle: "h:1",
        title: "Multi   line\n\ttitle",
        abstract: "lots\n\n  of   space",
      },
    });
    expect(md).toContain('"Multi line title"');
    expect(md).toContain("Abstract: lots of space");
  });

  it("numbers multiple papers sequentially", () => {
    const md = buildMarkdown("", { a: normalPaper, b: { handle: "h:2", title: "Second" } });
    expect(md).toContain("1. Doe, Jane");
    expect(md).toContain('2. Unknown author "Second"');
  });
});

describe("sourcesHtml", () => {
  it("returns empty string for no papers", () => {
    expect(sourcesHtml({})).toBe("");
    expect(sourcesHtml(null)).toBe("");
  });

  it("escapes &, < and > in fields", () => {
    const html = sourcesHtml({
      a: {
        handle: "h:1",
        title: "A < B & C > D",
        authors: ["Smith & Jones"],
        abstract: "x < y & z > w",
      },
    });
    expect(html).toContain("&amp;");
    expect(html).toContain("&lt;");
    expect(html).toContain("&gt;");
    expect(html).not.toMatch(/<(?!\/?(h2|ol|li|span|em|p)\b)/);
  });

  it("wraps entries in an ordered list with the Sources heading", () => {
    const html = sourcesHtml({ a: normalPaper });
    expect(html).toContain("<h2>Sources</h2>");
    expect(html).toContain('<ol class="sources">');
    expect(html).toContain("<em>Journal of Things</em>");
  });
});
