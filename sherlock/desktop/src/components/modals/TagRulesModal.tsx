import { useEffect, useState } from "react";
import ModalOverlay from "./ModalOverlay";
import * as api from "../../api";
import type { TagRule } from "../../types";
import "./shared-modal.css";
import "./TagRulesModal.css";

type Props = {
  onClose: () => void;
};

export default function TagRulesModal({ onClose }: Props) {
  const [rules, setRules] = useState<TagRule[]>([]);
  const [pattern, setPattern] = useState("");
  const [tag, setTag] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.listTagRules().then(setRules).finally(() => setLoading(false));
  }, []);

  async function handleAdd() {
    const p = pattern.trim();
    const t = tag.trim();
    if (!p) { setError("Pattern is required"); return; }
    if (!t) { setError("Tag is required"); return; }
    try {
      new RegExp(p); // validate regex
    } catch {
      setError("Invalid regex pattern");
      return;
    }
    try {
      const rule = await api.createTagRule(p, t);
      setRules((prev) => [...prev, rule]);
      setPattern("");
      setTag("");
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleDelete(id: number) {
    await api.deleteTagRule(id);
    setRules((prev) => prev.filter((r) => r.id !== id));
  }

  async function handleToggle(rule: TagRule) {
    await api.setTagRuleEnabled(rule.id, !rule.enabled);
    setRules((prev) =>
      prev.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r))
    );
  }

  return (
    <ModalOverlay onBackdropClick={onClose}>
      <div className="modal-base tag-rules-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Path-Pattern Tag Rules</h3>
        <p className="tag-rules-hint">
          When a file's relative path matches a regex pattern, the tag is
          automatically added to its mentions at scan time.
        </p>

        {loading ? (
          <p className="tag-rules-loading">Loading…</p>
        ) : (
          <table className="tag-rules-table">
            <thead>
              <tr>
                <th>On</th>
                <th>Pattern (regex)</th>
                <th>Tag</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rules.length === 0 && (
                <tr>
                  <td colSpan={4} className="tag-rules-empty">No rules yet</td>
                </tr>
              )}
              {rules.map((rule) => (
                <tr key={rule.id} className={rule.enabled ? "" : "tag-rule-disabled"}>
                  <td>
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={() => handleToggle(rule)}
                      aria-label={`Enable rule ${rule.id}`}
                    />
                  </td>
                  <td className="tag-rules-pattern">
                    <code>{rule.pattern}</code>
                  </td>
                  <td className="tag-rules-tag">{rule.tag}</td>
                  <td>
                    <button
                      type="button"
                      className="tag-rules-delete"
                      onClick={() => handleDelete(rule.id)}
                      aria-label="Delete rule"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="tag-rules-add-row">
          <input
            type="text"
            value={pattern}
            onChange={(e) => { setPattern(e.target.value); setError(null); }}
            placeholder="Regex pattern (e.g. ^Screenshots/)"
            aria-label="Pattern"
            className="tag-rules-input-pattern"
          />
          <input
            type="text"
            value={tag}
            onChange={(e) => { setTag(e.target.value); setError(null); }}
            placeholder="Tag"
            aria-label="Tag"
            className="tag-rules-input-tag"
            onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
          />
          <button type="button" onClick={handleAdd} className="tag-rules-add-btn">
            Add
          </button>
        </div>
        {error && <p className="tag-rules-error">{error}</p>}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </ModalOverlay>
  );
}
