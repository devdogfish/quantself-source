"use client";

import { useEffect, useState } from "react";
import { SunIcon, CloudIcon, CloudRainIcon, SnowflakeIcon, CloudLightningIcon } from "lucide-react";
import { resolveLocationWeather, weatherCondition, type LocationWeather } from "./location-weather";

export function TodoLocationWeather({ lat, lon }: { lat: number; lon: number }) {
  const key = `${lat},${lon}`;
  const [result, setResult] = useState<{ key: string; weather: LocationWeather | null } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void resolveLocationWeather(lat, lon, controller.signal).then(weather => {
      if (!controller.signal.aborted) setResult({ key, weather });
    }).catch(() => {});
    return () => controller.abort();
  }, [lat, lon, key]);
  const weather = result?.key === key ? result.weather : null;
  if (!weather) return null;
  const condition = weatherCondition(weather.code)!;
  const Icon = { sun: SunIcon, cloud: CloudIcon, rain: CloudRainIcon, snow: SnowflakeIcon, storm: CloudLightningIcon }[condition.icon];
  return <span title={`Today's weather · ${condition.label} · degrees Celsius`} aria-label={`Today's weather: ${condition.label}, high ${weather.high} degrees Celsius, low ${weather.low} degrees Celsius`} style={{ display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap", fontSize: 12 }}>
    <Icon size={18} aria-hidden="true" />
    <span>H:{weather.high}° L:{weather.low}°</span>
  </span>;
}
