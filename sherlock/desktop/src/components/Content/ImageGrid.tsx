import { useMemo, useState } from "react";
import type { RefObject } from "react";
import type { SearchItem } from "../../types";
import ImageTile from "./ImageTile";

const BURST_GAP_NS = 2_000_000_000; // 2 seconds in nanoseconds

/**
 * Detect bursts from a date-sorted list of items.
 * Returns a map of { coverId → memberIds[] } for bursts of ≥3 consecutive items
 * with ≤2s mtime gap.
 */
function computeBurstGroups(items: SearchItem[]): Map<number, number[]> {
  const groups = new Map<number, number[]>();
  let i = 0;
  while (i < items.length) {
    let j = i + 1;
    while (
      j < items.length &&
      items[j].mtimeNs - items[j - 1].mtimeNs <= BURST_GAP_NS
    ) {
      j++;
    }
    if (j - i >= 3) {
      const coverId = items[i].id;
      const memberIds = items.slice(i + 1, j).map((x) => x.id);
      groups.set(coverId, memberIds);
      i = j;
    } else {
      i++;
    }
  }
  return groups;
}

type ImageGridProps = {
  items: SearchItem[];
  selectedIndices: Set<number>;
  focusIndex: number | null;
  gridRef: RefObject<HTMLDivElement>;
  onTileClick: (idx: number, e: React.MouseEvent) => void;
  onTileDoubleClick: (idx: number) => void;
  onTileContextMenu: (idx: number, e: React.MouseEvent) => void;
  /** When true, consecutive items within 2s are collapsed into a burst group */
  collapseBursts?: boolean;
};

export default function ImageGrid({
  items, selectedIndices, focusIndex, gridRef,
  onTileClick, onTileDoubleClick, onTileContextMenu,
  collapseBursts = false,
}: ImageGridProps) {
  const [expandedBursts, setExpandedBursts] = useState<Set<number>>(new Set());

  const burstGroups = useMemo(
    () => (collapseBursts ? computeBurstGroups(items) : new Map<number, number[]>()),
    [items, collapseBursts]
  );

  // Build set of IDs that are hidden (non-cover burst members when collapsed)
  const hiddenIds = useMemo(() => {
    const hidden = new Set<number>();
    for (const [coverId, memberIds] of burstGroups) {
      if (!expandedBursts.has(coverId)) {
        for (const id of memberIds) hidden.add(id);
      }
    }
    return hidden;
  }, [burstGroups, expandedBursts]);

  function toggleBurst(coverId: number) {
    setExpandedBursts((prev) => {
      const next = new Set(prev);
      if (next.has(coverId)) next.delete(coverId);
      else next.add(coverId);
      return next;
    });
  }

  return (
    <div className="grid" role="list" ref={gridRef}>
      {items.map((item, idx) => {
        if (hiddenIds.has(item.id)) return null;

        const burstMembers = burstGroups.get(item.id);
        const burstCount = burstMembers?.length ?? 0;
        const isCollapsed = burstCount > 0 && !expandedBursts.has(item.id);

        return (
          <div key={item.id} className="image-tile-wrapper" style={{ position: "relative" }}>
            <ImageTile
              item={item}
              index={idx}
              isSelected={selectedIndices.has(idx)}
              isFocused={focusIndex === idx}
              onClick={onTileClick}
              onDoubleClick={onTileDoubleClick}
              onContextMenu={onTileContextMenu}
            />
            {burstCount > 0 && (
              <button
                className={`burst-badge${isCollapsed ? " burst-badge-collapsed" : " burst-badge-expanded"}`}
                title={isCollapsed ? `Burst: +${burstCount} more — click to expand` : "Collapse burst"}
                onClick={(e) => { e.stopPropagation(); toggleBurst(item.id); }}
                aria-label={isCollapsed ? `Show ${burstCount} more burst photos` : "Collapse burst photos"}
              >
                {isCollapsed ? `+${burstCount}` : "−"}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
