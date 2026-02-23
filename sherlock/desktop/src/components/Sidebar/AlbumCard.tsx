import type { Album } from "../../types";

type Props = {
  album: Album;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
};

export default function AlbumCard({ album, isSelected, onSelect, onDelete }: Props) {
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
        <span className="root-card-icon">&#128214;</span>
        <span className="root-card-name" title={album.name}>{album.name}</span>
        <button
          type="button"
          className="root-card-delete"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title="Delete album"
          aria-label={`Delete ${album.name}`}
        >&times;</button>
      </div>
      <div className="root-card-meta">
        <span>{album.fileCount.toLocaleString()} files</span>
      </div>
    </div>
  );
}
