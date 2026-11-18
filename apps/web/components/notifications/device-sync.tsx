"use client";
import { useEffect } from "react";
export function NotificationDeviceSync() {
  useEffect(() => {
    let active = false;
    let syncedZone: string | undefined;
    async function sync() {
      if (active || document.visibilityState !== "visible" || !("serviceWorker" in navigator) || !("Notification" in window) || Notification.permission !== "granted") return;
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (timeZone === syncedZone) return;
      active = true;
      try {
        const registration = await navigator.serviceWorker.getRegistration("/");
        const subscription = await registration?.pushManager.getSubscription();
        if (subscription) { const response = await fetch("/api/v1/notifications/devices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...subscription.toJSON(), timeZone }) });
          if (response.ok) syncedZone = timeZone;
        }
      } catch { /* Settings enrollment remains available for recovery. */ }
      finally { active = false; }
    }
    void sync();
    document.addEventListener("visibilitychange", sync);
    const timer = setInterval(sync, 60000);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", sync); };
  }, []);
  return null;
}
