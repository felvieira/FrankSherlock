/**
 * ChipSearchBar — replaces the plain <input> in Toolbar.
 *
 * UX: user types free text. Typing "camera:" (with colon) converts the token
 * into a coloured chip with an inline value field. Pressing Enter or Space
 * finalises the chip. Delete via × button or Backspace on empty input.
 *
 * The component serialises chips + free text back to the same query string
 * format the Rust parser already understands (e.g. `camera:"Sony A7" time:morning`).
 */
import { useCallback, useEffect, useId, useReducer, useRef, useState } from "react";
import type { SearchChip } from "../../types";
import TagAutocomplete from "./TagAutocomplete";
import "./ChipSearchBar.css";

const FACETS = ["camera", "lens", "time", "person", "album", "subdir", "media"] as const;
type Facet = (typeof FACETS)[number];

const FACET_LABELS: Record<Facet, string> = {
  camera: "Camera",
  lens: "Lens",
  time: "Time",
  person: "Person",
  album: "Album",
  subdir: "Folder",
  media: "Type",
};

// ── Reducer ──────────────────────────────────────────────────────────

type State = {
  chips: SearchChip[];
  freeText: string;
  /** When non-null, the user is typing the value for a pending chip */
  pendingFacet: Facet | null;
  pendingValue: string;
};

type Action =
  | { type: "SET_FREE_TEXT"; text: string }
  | { type: "START_CHIP"; facet: Facet }
  | { type: "SET_PENDING_VALUE"; value: string }
  | { type: "COMMIT_CHIP" }
  | { type: "CANCEL_PENDING" }
  | { type: "DELETE_CHIP"; id: string }
  | { type: "RESET"; query: string };

function parseQueryToState(query: string): State {
  const chips: SearchChip[] = [];
  let remaining = query;

  // Extract known facet tokens, e.g. camera:"Sony A7" or lens:50mm
  for (const facet of FACETS) {
    const re = new RegExp(`\\b${facet}:(?:"([^"]*?)"|([^\\s]+))`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(remaining)) !== null) {
      chips.push({ id: `${facet}-${Date.now()}-${Math.random()}`, facet, value: m[1] ?? m[2] ?? "" });
    }
    remaining = remaining.replace(re, "").trim();
  }

  return { chips, freeText: remaining, pendingFacet: null, pendingValue: "" };
}

function serializeState(state: State): string {
  const parts: string[] = [];
  for (const chip of state.chips) {
    const val = chip.value.includes(" ") ? `"${chip.value}"` : chip.value;
    parts.push(`${chip.facet}:${val}`);
  }
  if (state.freeText.trim()) parts.push(state.freeText.trim());
  return parts.join(" ");
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "SET_FREE_TEXT":
      return { ...state, freeText: action.text };

    case "START_CHIP":
      return { ...state, pendingFacet: action.facet, pendingValue: "", freeText: state.freeText };

    case "SET_PENDING_VALUE":
      return { ...state, pendingValue: action.value };

    case "COMMIT_CHIP": {
      if (!state.pendingFacet || !state.pendingValue.trim()) {
        return { ...state, pendingFacet: null, pendingValue: "" };
      }
      const chip: SearchChip = {
        id: `${state.pendingFacet}-${Date.now()}`,
        facet: state.pendingFacet,
        value: state.pendingValue.trim(),
      };
      return { ...state, chips: [...state.chips, chip], pendingFacet: null, pendingValue: "" };
    }

    case "CANCEL_PENDING":
      return { ...state, pendingFacet: null, pendingValue: "" };

    case "DELETE_CHIP":
      return { ...state, chips: state.chips.filter((c) => c.id !== action.id) };

    case "RESET":
      return parseQueryToState(action.query);

    default:
      return state;
  }
}

// ── Component ─────────────────────────────────────────────────────────

type Props = {
  query: string;
  onQueryChange: (query: string) => void;
  placeholder?: string;
};

export default function ChipSearchBar({ query, onQueryChange, placeholder }: Props) {
  const uid = useId();
  const [state, dispatch] = useReducer(reducer, query, parseQueryToState);
  const [showFacetMenu, setShowFacetMenu] = useState(false);
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const syncingRef = useRef(false);

  // Keep state in sync when query changes from outside (e.g. sidebar album click)
  useEffect(() => {
    if (syncingRef.current) return;
    dispatch({ type: "RESET", query });
  }, [query]);

  // Emit query change upward whenever chips or freeText change
  const prevQueryRef = useRef(query);
  useEffect(() => {
    const serialized = serializeState(state);
    if (serialized === prevQueryRef.current) return;
    prevQueryRef.current = serialized;
    syncingRef.current = true;
    onQueryChange(serialized);
    // Reset flag after the parent re-render cycle
    requestAnimationFrame(() => { syncingRef.current = false; });
  }, [state, onQueryChange]);

  const handleFreeKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === ":" && !e.ctrlKey && !e.metaKey) {
      // Check if text before cursor is a known facet
      const val = (e.target as HTMLInputElement).value;
      const facet = FACETS.find((f) => val.trimEnd() === f);
      if (facet) {
        e.preventDefault();
        dispatch({ type: "SET_FREE_TEXT", text: "" });
        dispatch({ type: "START_CHIP", facet });
        setShowFacetMenu(false);
        setShowAutocomplete(false);
        setTimeout(() => pendingRef.current?.focus(), 0);
        return;
      }
    }
    if (e.key === "Backspace" && !state.freeText && state.chips.length > 0) {
      // Delete last chip
      dispatch({ type: "DELETE_CHIP", id: state.chips[state.chips.length - 1].id });
    }
    if (e.key === "Escape") setShowAutocomplete(false);
  }, [state.freeText, state.chips]);

  const handlePendingKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      dispatch({ type: "COMMIT_CHIP" });
      setShowAutocomplete(false);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
    if (e.key === "Escape") {
      dispatch({ type: "CANCEL_PENDING" });
      setShowAutocomplete(false);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, []);

  const handleAutocompleteSelect = useCallback((label: string) => {
    if (state.pendingFacet) {
      dispatch({ type: "SET_PENDING_VALUE", value: label });
      dispatch({ type: "COMMIT_CHIP" });
      setShowAutocomplete(false);
      setTimeout(() => inputRef.current?.focus(), 0);
    } else {
      // Insert into free text
      dispatch({ type: "SET_FREE_TEXT", text: label });
      setShowAutocomplete(false);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [state.pendingFacet]);

  return (
    <div className="chip-search-bar" ref={containerRef} role="search">
      {/* Rendered chips */}
      {state.chips.map((chip) => (
        <span
          key={chip.id}
          className={`chip chip--${chip.facet}`}
          title={`${chip.facet}:${chip.value}`}
        >
          <span className="chip__label">
            <span className="chip__facet">{FACET_LABELS[chip.facet as Facet] ?? chip.facet}</span>
            {": "}
            <span className="chip__value">{chip.value}</span>
          </span>
          <button
            className="chip__delete"
            aria-label={`Remove ${chip.facet} filter`}
            onClick={() => dispatch({ type: "DELETE_CHIP", id: chip.id })}
            type="button"
          >
            ×
          </button>
        </span>
      ))}

      {/* Pending chip value input */}
      {state.pendingFacet && (
        <span className={`chip chip--${state.pendingFacet} chip--pending`}>
          <span className="chip__facet">{FACET_LABELS[state.pendingFacet as Facet] ?? state.pendingFacet}:</span>
          <div className="chip__pending-wrapper">
            <input
              ref={pendingRef}
              className="chip__pending-input"
              value={state.pendingValue}
              onChange={(e) => {
                dispatch({ type: "SET_PENDING_VALUE", value: e.target.value });
                setShowAutocomplete(e.target.value.length > 0);
              }}
              onKeyDown={handlePendingKeyDown}
              onBlur={() => {
                setTimeout(() => {
                  if (!containerRef.current?.contains(document.activeElement)) {
                    dispatch({ type: "COMMIT_CHIP" });
                    setShowAutocomplete(false);
                  }
                }, 150);
              }}
              placeholder="type value…"
              autoComplete="off"
              aria-label={`${state.pendingFacet} filter value`}
              aria-autocomplete="list"
              aria-controls={`${uid}-autocomplete`}
            />
            {showAutocomplete && (
              <div id={`${uid}-autocomplete`} className="chip__autocomplete-anchor">
                <TagAutocomplete
                  prefix={state.pendingValue}
                  onSelect={handleAutocompleteSelect}
                  onClose={() => setShowAutocomplete(false)}
                />
              </div>
            )}
          </div>
        </span>
      )}

      {/* Free-text input */}
      {!state.pendingFacet && (
        <div className="chip-search-bar__input-wrapper">
          <input
            ref={inputRef}
            type="search"
            className="chip-search-bar__input"
            value={state.freeText}
            onChange={(e) => {
              dispatch({ type: "SET_FREE_TEXT", text: e.target.value });
              setShowAutocomplete(e.target.value.length > 0);
              setShowFacetMenu(false);
            }}
            onKeyDown={handleFreeKeyDown}
            onFocus={() => {
              if (state.freeText.length > 0) setShowAutocomplete(true);
            }}
            onBlur={() => {
              setTimeout(() => {
                if (!containerRef.current?.contains(document.activeElement)) {
                  setShowAutocomplete(false);
                  setShowFacetMenu(false);
                }
              }, 150);
            }}
            placeholder={state.chips.length === 0 ? (placeholder ?? "Search… (F1 for help)") : ""}
            autoComplete="off"
            aria-label="Search query"
            aria-autocomplete="list"
            aria-controls={`${uid}-free-autocomplete`}
          />
          {showAutocomplete && state.freeText.length > 0 && (
            <div id={`${uid}-free-autocomplete`} className="chip-search-bar__autocomplete-anchor">
              <TagAutocomplete
                prefix={state.freeText}
                onSelect={handleAutocompleteSelect}
                onClose={() => setShowAutocomplete(false)}
              />
            </div>
          )}
        </div>
      )}

      {/* Facet menu toggle */}
      <button
        className="chip-search-bar__facet-btn"
        type="button"
        title="Add filter…"
        aria-label="Add filter"
        aria-expanded={showFacetMenu}
        onClick={() => setShowFacetMenu((v) => !v)}
      >
        +
      </button>
      {showFacetMenu && (
        <ul className="chip-search-bar__facet-menu" role="menu" aria-label="Filter facets">
          {FACETS.map((facet) => (
            <li key={facet} role="none">
              <button
                role="menuitem"
                type="button"
                className="chip-search-bar__facet-option"
                onClick={() => {
                  dispatch({ type: "START_CHIP", facet });
                  setShowFacetMenu(false);
                  setTimeout(() => pendingRef.current?.focus(), 0);
                }}
              >
                {FACET_LABELS[facet]}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
