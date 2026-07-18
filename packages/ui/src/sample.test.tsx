import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index";
import { Hello } from "./sample";

describe("vitest + testing-library harness", () => {
  it("renders a component into jsdom", () => {
    render(<Hello name="Loam" />);
    expect(screen.getByText("Hello Loam")).toBeInTheDocument();
  });

  it("imports package source", () => {
    expect(PACKAGE_NAME).toBe("@loam-app/ui");
  });
});
