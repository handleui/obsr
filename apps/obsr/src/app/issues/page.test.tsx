import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import IssuesPage from "./page";

describe("issues page", () => {
  it("renders the placeholder copy", () => {
    const html = renderToStaticMarkup(<IssuesPage />);

    expect(html).toContain("Issue history UI is intentionally empty");
    expect(html).not.toContain("No issues yet");
  });
});
