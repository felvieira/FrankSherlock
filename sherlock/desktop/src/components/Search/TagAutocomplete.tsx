/**
 * TagAutocomplete — dropdown that calls suggest_cmd and surfaces ranked suggestions.
 *
 * Props:
 *   prefix    – the current partial value being typed
 *   onSelect  – called when the user picks a suggestion (passes the label)
 *   onClose   – called when the dropdown should dismiss without picking
 */
import { useEffect, useRef, useState } from "react";
import { suggestTags } from "../../api";
import type { Suggestion } from "../../types";
import "./TagAutocomplete.css";

type Props = {
  prefix: string;
  onSelect: (label: string) => void;
  onClose: () => void;
};

const KIND_ICONS: Record<string, string> = {
  person: "👤",
  camera: "📷",
  lens: "🔭",
  mention: "#",
};

export default function TagAutocomplete({ prefix, onSelect, onClose }: Props) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Debounced fetch
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!prefix.trim()) {
      setSuggestions([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await suggestTags(prefix.trim(), 8);
        setSuggestions(results);
        setActiveIndex(0);
      } catch {
        setSuggestions([]);
      }
    }, 150);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [prefix]);

  // Keyboard navigation — parent binds keyboard events and calls these
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!suggestions.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        onSelect(suggestions[activeIndex].label);
      } else if (e.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [suggestions, activeIndex, onSelect, onClose]);

  // Scroll active item into view
  useEffect(() => {
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!suggestions.length) return null;

  return (
    <ul className="tag-autocomplete" role="listbox" ref={listRef} aria-label="Search suggestions">
      {suggestions.map((s, i) => (
        <li
          key={`${s.kind}-${s.label}`}
          role="option"
          aria-selected={i === activeIndex}
          className={`tag-autocomplete__item${i === activeIndex ? " tag-autocomplete__item--active" : ""}`}
          onMouseDown={(e) => {
            // mousedown fires before blur, prevents input from losing focus first
            e.preventDefault();
            onSelect(s.label);
          }}
          onMouseEnter={() => setActiveIndex(i)}
        >
          <span className="tag-autocomplete__icon" title={s.kind}>
            {KIND_ICONS[s.kind] ?? "#"}
          </span>
          <span className="tag-autocomplete__label">{s.label}</span>
          <span className="tag-autocomplete__count">{s.count}</span>
        </li>
      ))}
    </ul>
  );
}
