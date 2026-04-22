import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TimelineHeatmap from "../../components/Content/TimelineHeatmap";

vi.mock("../../api", () => ({
  listTimelineBuckets: vi.fn(),
}));

import { listTimelineBuckets } from "../../api";
const mockList = listTimelineBuckets as ReturnType<typeof vi.fn>;

describe("TimelineHeatmap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state initially then renders rows", async () => {
    mockList.mockResolvedValue([
      { bucket: "2023-01", count: 5 },
      { bucket: "2023-06", count: 12 },
    ]);
    render(<TimelineHeatmap onQueryChange={() => {}} />);
    // After resolution, both months visible
    await waitFor(() => {
      expect(screen.getByTitle(/2023-01/)).toBeInTheDocument();
      expect(screen.getByTitle(/2023-06/)).toBeInTheDocument();
    });
  });

  it("shows month labels in short format", async () => {
    mockList.mockResolvedValue([{ bucket: "2023-06", count: 3 }]);
    render(<TimelineHeatmap onQueryChange={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText(/Jun '23/)).toBeInTheDocument();
    });
  });

  it("calls onQueryChange with date range when month clicked", async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    mockList.mockResolvedValue([{ bucket: "2023-06", count: 8 }]);
    render(<TimelineHeatmap onQueryChange={onQueryChange} />);
    await waitFor(() => screen.getByTitle(/2023-06/));
    await user.click(screen.getByTitle(/2023-06/));
    expect(onQueryChange).toHaveBeenCalledWith("2023-06-01 2023-06-30");
  });

  it("deselects (clears query) when active month clicked again", async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    mockList.mockResolvedValue([{ bucket: "2023-06", count: 8 }]);
    render(<TimelineHeatmap onQueryChange={onQueryChange} />);
    await waitFor(() => screen.getByTitle(/2023-06/));
    const btn = screen.getByTitle(/2023-06/);
    await user.click(btn);
    await user.click(btn);
    // Second click should pass empty string
    const calls = onQueryChange.mock.calls;
    expect(calls.at(-1)?.[0]).toBe("");
  });

  it("shows 'No photos yet' when list is empty", async () => {
    mockList.mockResolvedValue([]);
    render(<TimelineHeatmap onQueryChange={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText("No photos yet")).toBeInTheDocument();
    });
  });
});
