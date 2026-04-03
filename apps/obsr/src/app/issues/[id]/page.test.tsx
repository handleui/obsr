import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import IssueDetailPage from "./page";

describe("issue detail page", () => {
  it("renders the placeholder copy", () => {
    const html = renderToStaticMarkup(<IssueDetailPage />);

    expect(html).toContain("Issue detail UI is intentionally empty");
    expect(html).not.toContain("Observations");
  });
});
