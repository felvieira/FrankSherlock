import { useEffect, useRef, useState } from "react";
import ModalOverlay from "./ModalOverlay";
import "./shared-modal.css";
import "./RenameModal.css";

type Props = {
  query: string;
  onCancel: () => void;
  onConfirm: (name: string) => void;
};

export default function CreateSmartFolderModal({ query, onCancel, onConfirm }: Props) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function handleSubmit() {
    const trimmed = value.trim();
    if (!trimmed) {
      setError("Folder name cannot be empty");
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
        <h3>Save Smart Folder</h3>
        <p className="smart-folder-query-preview">Query: <code>{query}</code></p>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => { setValue(e.target.value); setError(null); }}
          onKeyDown={handleKeyDown}
          placeholder="Folder name"
          aria-label="Folder name"
        />
        {error && <p className="rename-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="button" onClick={handleSubmit}>Save</button>
        </div>
      </div>
    </ModalOverlay>
  );
}
