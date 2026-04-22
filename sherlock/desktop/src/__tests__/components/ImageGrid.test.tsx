import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import ImageGrid from "../../components/Content/ImageGrid";
import type { SearchItem } from "../../types";

function makeItem(id: number, mtimeNs: number): SearchItem {
  return {
    id,
    rootId: 1,
    relPath: `photo_${id}.jpg`,
    absPath: `/photos/photo_${id}.jpg`,
    mediaType: "photo",
    description: `Photo ${id}`,
    confidence: 0.9,
    mtimeNs,
    sizeBytes: 1024,
  };
}

// 3 items within 2s → burst
const BASE_NS = 1_700_000_000_000_000_000;
const BURST_ITEMS: SearchItem[] = [
  makeItem(1, BASE_NS),
  makeItem(2, BASE_NS + 500_000_000),   // +0.5s
  makeItem(3, BASE_NS + 1_000_000_000), // +1s
  makeItem(4, BASE_NS + 3_600_000_000_000), // +1h — separate non-burst item
];

const defaultGridProps = {
  selectedIndices: new Set<number>(),
  focusIndex: null,
  gridRef: createRef<HTMLDivElement>() as React.RefObject<HTMLDivElement>,
  onTileClick: vi.fn(),
  onTileDoubleClick: vi.fn(),
  onTileContextMenu: vi.fn(),
};

describe("ImageGrid", () => {
  it("renders all items without burst collapse", () => {
    render(<ImageGrid items={BURST_ITEMS} {...defaultGridProps} />);
    // Each filename appears twice (tile-filename + hover-overlay)
    expect(screen.getAllByText("photo_1.jpg").length).toBeGreaterThan(0);
    expect(screen.getAllByText("photo_2.jpg").length).toBeGreaterThan(0);
    expect(screen.getAllByText("photo_3.jpg").length).toBeGreaterThan(0);
    expect(screen.getAllByText("photo_4.jpg").length).toBeGreaterThan(0);
  });

  it("collapses burst members and shows badge when collapseBursts=true", () => {
    render(<ImageGrid items={BURST_ITEMS} {...defaultGridProps} collapseBursts={true} />);
    // Cover (id=1) is shown
    expect(screen.getAllByText("photo_1.jpg").length).toBeGreaterThan(0);
    // Burst members (id=2, id=3) are collapsed — not in DOM at all
    expect(screen.queryAllByText("photo_2.jpg")).toHaveLength(0);
    expect(screen.queryAllByText("photo_3.jpg")).toHaveLength(0);
    // Non-burst item (id=4) is still shown
    expect(screen.getAllByText("photo_4.jpg").length).toBeGreaterThan(0);
    // Badge shows "+2"
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  it("expands burst when badge is clicked", async () => {
    const user = userEvent.setup();
    render(<ImageGrid items={BURST_ITEMS} {...defaultGridProps} collapseBursts={true} />);
    const badge = screen.getByText("+2");
    await user.click(badge);
    // Now members should be visible (each appears twice in tile DOM)
    expect(screen.getAllByText("photo_2.jpg").length).toBeGreaterThan(0);
    expect(screen.getAllByText("photo_3.jpg").length).toBeGreaterThan(0);
  });

  it("does not show burst badge when collapseBursts is false (default)", () => {
    render(<ImageGrid items={BURST_ITEMS} {...defaultGridProps} collapseBursts={false} />);
    expect(screen.queryByText("+2")).not.toBeInTheDocument();
  });
});
