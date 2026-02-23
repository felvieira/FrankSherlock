import { useEffect, useRef, useState } from "react";
import ModalOverlay from "./ModalOverlay";
import "./shared-modal.css";
import "./RenameModal.css";

type Props = {
  onCancel: () => void;
  onConfirm: (name: string) => void;
};

export default function CreateAlbumModal({ onCancel, onConfirm }: Props) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function handleSubmit() {
    const trimmed = value.trim();
    if (!trimmed) {
      setError("Album name cannot be empty");
      return;
    }
    onConfirm(trimmed);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  }

  return (
    <ModalOverlay onBackdropClick={onCancel}>
      <div className="modal-base rename-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Create Album</h3>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => { setValue(e.target.value); setError(null); }}
          onKeyDown={handleKeyDown}
          placeholder="Album name"
          aria-label="Album name"
        />
        {error && <p className="rename-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="button" onClick={handleSubmit}>Create</button>
        </div>
      </div>
    </ModalOverlay>
  );
}
