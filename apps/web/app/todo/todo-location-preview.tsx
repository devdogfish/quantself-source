"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Map as LeafletMap } from "leaflet";
import "leaflet/dist/leaflet.css";
import { resolveLocationPreview } from "./location-preview";
import { TodoLocationWeather } from "./todo-location-weather";
import styles from "./todo-location-preview.module.css";

type Coordinates = NonNullable<Awaited<ReturnType<typeof resolveLocationPreview>>>;

function LocationMap({ point, onError }: { point: Coordinates; onError: () => void }) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false;
    let map: LeafletMap | undefined;
    let resize: ResizeObserver | undefined;
    void import("leaflet").then(L => {
      if (disposed || !element.current) return;
      map = L.map(element.current, { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false, boxZoom: false, keyboard: false }).setView([point.lat, point.lon], 15);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).on("tileerror", onError).addTo(map);
      L.marker([point.lat, point.lon], { interactive: false, keyboard: false, icon: L.divIcon({ className: styles.pin, html: '<span></span>', iconSize: [26, 34], iconAnchor: [13, 34] }) }).addTo(map);
      map.invalidateSize();
      resize = new ResizeObserver(() => map?.invalidateSize({ pan: false }));
      resize.observe(element.current);
    }).catch(() => { if (!disposed) onError(); });
    return () => { disposed = true; resize?.disconnect(); map?.remove(); };
  }, [point, onError]);
  return <div ref={element} className={styles.map} aria-hidden="true" />;
}

export function TodoLocationPreview({ location }: { location: string }) {
  const query = location.trim();
  const [result, setResult] = useState<{ query: string; point: Coordinates | null; error?: boolean } | null>(null);
  const [tileError, setTileError] = useState<string | null>(null);
  const handleTileError = useCallback(() => setTileError(query), [query]);
  useEffect(() => {
    setTileError(null);
    if (!query) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void resolveLocationPreview(query, controller.signal).then(point => {
        if (!controller.signal.aborted) setResult({ query, point });
      }).catch(() => {
        if (!controller.signal.aborted) setResult({ query, point: null, error: true });
      });
    }, 500);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);
  if (!query) return null;
  const current = result?.query === query ? result : null;
  const point = current?.point;
  const href = `https://maps.apple.com/search?${new URLSearchParams({ query })}`;
  return <section className={styles.card} aria-label="Location map preview">
    <div className={styles.surface}>
      {point && tileError !== query && <LocationMap key={query} point={point} onError={handleTileError} />}
      {(!point || tileError === query) && <span className={styles.fallback} role="status">{!current ? "Loading map…" : current.error || tileError === query ? "Map unavailable" : "No map preview"}</span>}
      <a className={styles.openMap} href={href} target="_blank" rel="noopener noreferrer" aria-label={`Open ${query} in Apple Maps`} />
      {point && <span className={styles.attribution}><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap</a><span aria-hidden="true"> · </span><a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">Open-Meteo</a></span>}
    </div>
    <a className={styles.footer} href={href} target="_blank" rel="noopener noreferrer" title={point?.label || query}>
      <span className={styles.label}>{point?.locality || query}</span>
      {point && <TodoLocationWeather lat={point.lat} lon={point.lon} />}
    </a>
  </section>;
}
