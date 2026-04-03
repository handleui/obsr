import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "./page";

describe("home page", () => {
  it("renders the placeholder copy", () => {
    const html = renderToStaticMarkup(<Home />);

    expect(html).toContain("intentionally empty right now");
    expect(html).not.toContain("Create issue");
  });
});
