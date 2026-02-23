import ModalOverlay from "./ModalOverlay";
import "./shared-modal.css";
import "./HelpModal.css";

type Props = {
  onClose: () => void;
};

export default function HelpModal({ onClose }: Props) {
  return (
    <ModalOverlay onBackdropClick={onClose}>
      <div className="modal-base help-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Search help</h3>

        <div className="help-section">
          <h4>Free text</h4>
          <div className="help-examples">
            <code>ranma</code>
            <code>beach sunset</code>
          </div>
        </div>

        <div className="help-section">
          <h4>Media types</h4>
          <div className="help-examples">
            <code>anime ranma</code>
            <code>photo beach</code>
            <code>screenshot</code>
            <code>receipt santander</code>
          </div>
        </div>

        <div className="help-section">
          <h4>Date: year range</h4>
          <div className="help-examples">
            <code>between 2023 and 2024</code>
          </div>
        </div>

        <div className="help-section">
          <h4>Date: from year</h4>
          <div className="help-examples">
            <code>from 2022</code>
          </div>
        </div>

        <div className="help-section">
          <h4>Date: exact (ISO)</h4>
          <div className="help-examples">
            <code>2023-06-15</code>
            <code>2023-01-01 2023-12-31</code>
          </div>
        </div>

        <div className="help-section">
          <h4>Confidence</h4>
          <div className="help-examples">
            <code>anime confidence &gt;= 0.8</code>
            <code>min confidence &gt; 0.7</code>
          </div>
        </div>

        <div className="help-section">
          <h4>Folder filter</h4>
          <div className="help-examples">
            <code>in Dropbox</code>
            <code>receipts in Downloads</code>
          </div>
        </div>

        <div className="help-section">
          <h4>Combined</h4>
          <div className="help-examples">
            <code>anime between 2023 and 2024</code>
            <code>receipts in Dropbox confidence &gt;= 0.9</code>
            <code>photos from 2022 in Camera</code>
          </div>
        </div>

        <p className="help-note">
          Filters combine with AND. If no results, media type and confidence filters relax automatically.
        </p>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>Close</button>
        </div>

        <p className="help-shortcut">Press F1 to toggle</p>
      </div>
    </ModalOverlay>
  );
}
