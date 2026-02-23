import type { SmartFolder } from "../../types";

type Props = {
  folder: SmartFolder;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
};

export default function SmartFolderCard({ folder, isSelected, onSelect, onDelete }: Props) {
  return (
    <div
      className={`root-card${isSelected ? " selected" : ""}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="root-card-header">
        <span className="root-card-icon">&#128269;</span>
        <span className="root-card-name" title={folder.name}>{folder.name}</span>
        <button
          type="button"
          className="root-card-delete"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title="Delete smart folder"
          aria-label={`Delete ${folder.name}`}
        >&times;</button>
      </div>
      <div className="root-card-meta">
        <span title={folder.query}>{folder.query}</span>
      </div>
    </div>
  );
}
