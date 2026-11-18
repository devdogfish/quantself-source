"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { MapPinIcon } from "lucide-react";
import { Popover, Portal, Textarea } from "@chakra-ui/react";
import { useNestedOverlayRegistration } from "@/components/shared/nested-overlay-guard";
import { useJarvisDraft } from "./jarvis-ui";
import { searchLocations, type LocationSuggestion } from "./location-search";
import detailStyles from "./todo-detail.module.css";
import styles from "./todo-location-input.module.css";

const positioning = { placement: "bottom-start", gutter: 4, overflowPadding: 12 } as const;

export function TodoLocationInput({ value, readOnly, onCommit, onSubmit }: {
  value: string; readOnly: boolean; onCommit(before: string, after: string): void; onSubmit?(): void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  // Saving a draft must not cancel the focused search or its pending response.
  const [query, setQuery] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [suggestions, setSuggestions] = useState<LocationSuggestion[]>([]);
  const [active, setActive] = useState(-1);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const baseline = useRef(value);
  if (draft === null) baseline.current = value;
  const input = useRef<HTMLTextAreaElement>(null);
  const skipBlurCommit = useRef(false);
  const request = useRef<AbortController | null>(null);
  const save = useRef<(value: string) => void>(() => {});
  useJarvisDraft(draft !== null && draft !== value);

  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    const resize = () => {
      element.style.height = "auto";
      if (element.scrollHeight) element.style.height = `${element.scrollHeight}px`;
    };
    resize();
    let width = element.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = element.getBoundingClientRect().width;
      if (nextWidth !== width) { width = nextWidth; resize(); }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [draft, value]);

  useEffect(() => {
    if (readOnly || draft === null || draft === baseline.current) return;
    const timer = setTimeout(() => save.current(draft), 3000);
    return () => clearTimeout(timer);
  }, [draft, readOnly]);

  useEffect(() => {
    if (!focused || readOnly || query === null || query.trim().length < 3) return;
    const controller = new AbortController();
    request.current = controller;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const debounce = setTimeout(() => {
      setStatus("Searching places…");
      timeout = setTimeout(() => { controller.abort(); setStatus("Location search timed out. You can still enter a location."); }, 8000);
      void searchLocations(query, controller.signal).then(results => {
        if (controller.signal.aborted) return;
        setSuggestions(results);
        setStatus(results.length ? "" : "No places found. Keep typing or use your own location.");
      }).catch(() => {
        if (!controller.signal.aborted) setStatus("Location search unavailable. You can still enter a location.");
      }).finally(() => clearTimeout(timeout));
    }, 500);
    return () => { clearTimeout(debounce); clearTimeout(timeout); controller.abort(); };
  }, [query, focused, readOnly]);

  function dismissSuggestions() {
    request.current?.abort();
    setQuery(null);
    setSuggestions([]); setActive(-1); setStatus("");
  }
  function commit(next: string, dismiss = false) {
    if (readOnly) return false;
    try {
      if (!readOnly && next !== baseline.current) onCommit(baseline.current, next);
      baseline.current = next;
      setDraft(null); setError("");
    } catch (error) {
      setDraft(next);
      setError(error instanceof Error ? error.message : "Unable to queue this change.");
      return false;
    }
    if (dismiss) dismissSuggestions();
    return true;
  }
  function select(suggestion: LocationSuggestion) {
    commit(suggestion.label, true);
    // Keep focus available for the next edit; blur must not repeat this command.
  }
  save.current = commit;
  const open = focused && !readOnly && (suggestions.length > 0 || !!status);
  useEffect(() => {
    if (open && active >= 0) input.current?.ownerDocument.getElementById(`${id}-place-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, id, open]);
  useNestedOverlayRegistration(open);
  return <Popover.Root open={open} onOpenChange={({ open }) => { if (!open) dismissSuggestions(); }}
    autoFocus={false} restoreFocus={false} portalled={false} positioning={positioning}
    persistentElements={[() => input.current]}
    onEscapeKeyDown={event => { event.preventDefault(); dismissSuggestions(); baseline.current = value; setDraft(null); }}>
    <div className={styles.root}>
      <Popover.Anchor asChild>
        <Textarea unstyled ref={input} rows={1} wrap="soft" role="combobox" aria-label="Location" aria-autocomplete="list" aria-expanded={open}
          data-inline-dirty={draft !== null || open}
          aria-controls={open ? `${id}-places` : undefined} aria-activedescendant={open && active >= 0 ? `${id}-place-${active}` : undefined}
          aria-invalid={!!error} autoComplete="off" placeholder="No location" readOnly={readOnly} maxLength={2000}
          value={draft ?? value} className={`${detailStyles.inlineText} ${styles.locationInput}`}
          onFocus={() => { if (draft === null) baseline.current = value; setFocused(true); }}
          onChange={event => { const next = event.target.value.replace(/[\r\n]+/g, " "); dismissSuggestions(); setDraft(next); setQuery(next); setError(""); }}
          onBlur={() => { setFocused(false); dismissSuggestions(); if (skipBlurCommit.current) { skipBlurCommit.current = false; return; } if (draft !== null) commit(draft); }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            if ((event.key === "ArrowDown" || event.key === "ArrowUp") && suggestions.length) {
              event.preventDefault();
              setActive(index => event.key === "ArrowDown" ? (index + 1) % suggestions.length : (index <= 0 ? suggestions.length - 1 : index - 1));
            } else if (event.key === "Escape" && (draft !== null || open)) {
              event.preventDefault(); event.stopPropagation(); dismissSuggestions(); baseline.current = value; setDraft(null);
            } else if (event.key === "Enter") {
              event.preventDefault(); event.stopPropagation();
              const suggestion = active >= 0 ? suggestions[active] : undefined;
              if (commit(suggestion?.label ?? draft ?? value, true) && (onSubmit || !suggestion)) {
                // Blur must not resubmit the pre-selection search text.
                skipBlurCommit.current = true;
                event.currentTarget.blur();
                onSubmit?.();
              }
            }
          }} />
      </Popover.Anchor>
      {open && <Portal>
        <Popover.Positioner>
          <Popover.Content className={styles.suggestions}>
            <p className={styles.heading} aria-hidden="true">Suggestions</p>
            <div id={`${id}-places`} role="listbox" aria-label="Suggested locations" className={styles.results}>
              {suggestions.map((suggestion, index) => <div key={suggestion.id} id={`${id}-place-${index}`} role="option"
                aria-selected={index === active} title={suggestion.label} className={styles.option}
                onPointerDown={event => event.preventDefault()} onMouseDown={event => event.preventDefault()} onClick={() => select(suggestion)} onMouseMove={() => setActive(index)}>
                <MapPinIcon aria-hidden="true" className={styles.pin} />
                <span className={styles.place}>
                  <span className={styles.name}>{suggestion.label.split(", ")[0]}</span>
                  {suggestion.label.includes(", ") && <span className={styles.address}>{suggestion.label.split(", ").slice(1).join(", ")}</span>}
                </span>
              </div>)}
            </div>
            {status && <p className={styles.status} role="status">{status}</p>}
            <p className={styles.attribution}><a href="https://github.com/komoot/photon" target="_blank" rel="noreferrer">Photon</a> · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a></p>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </div>
  </Popover.Root>;
}
