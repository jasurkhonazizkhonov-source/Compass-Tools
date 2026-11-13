import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PeriodKpi } from "../period-kpi";

// PeriodKpi (used only by Commissions and Salesboard) draws a label and a figure and nothing else - no comparison line.
describe("PeriodKpi", () => {
  it("renders the label and the figure only", () => {
    const html = renderToStaticMarkup(<PeriodKpi label="Total Commission" value="$50.00" />);
    expect(html).toContain("Total Commission");
    expect(html).toContain("$50.00");
    expect(html).not.toContain("period-kpi-comparison");
    expect(html.replace(/<[^>]+>/g, " ")).not.toMatch(/\bvs\b|%|previous|earlier/i);
  });

  it("emphasize still makes the figure larger", () => {
    expect(renderToStaticMarkup(<PeriodKpi label="Profit" value="$1" emphasize />)).toContain("text-lg font-semibold");
    expect(renderToStaticMarkup(<PeriodKpi label="Profit" value="$1" />)).toContain("text-base font-medium");
  });
});
