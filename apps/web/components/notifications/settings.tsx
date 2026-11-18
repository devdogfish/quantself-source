"use client";
import { useState } from "react";
import { Button, Field, HStack, Input, Stack, Text } from "@chakra-ui/react";
import { SettingsRow } from "@/app/settings/settings-row";
import {
  notificationRequest,
  optimisticSetting,
  useNotificationSetting,
} from "./client";
const settings = optimisticSetting<{ enabled: boolean; morning: string }>(
  "settings",
);
export function NotificationSettings() {
  const state = useNotificationSetting(settings);
  const [deviceStatus, setDeviceStatus] = useState("");
  const [enrolling, setEnrolling] = useState(false);
  async function enroll() {
    setEnrolling(true);
    setDeviceStatus("");
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window))
        throw Error(
          "On iPhone, add Quantself to the Home Screen and open it there first.",
        );
      const permission = await Notification.requestPermission();
      if (permission !== "granted")
        throw Error(
          "Allow notifications in your device settings, then try again.",
        );
      const configuration = await notificationRequest<{
        publicKey: string | null;
      }>("settings");
      if (!configuration.publicKey)
        throw Error("Notifications need server configuration.");
      const registration = await navigator.serviceWorker.register(
        "/notifications-sw.js",
      );
      await navigator.serviceWorker.ready;
      const key = Uint8Array.from(
        atob(configuration.publicKey.replace(/-/g, "+").replace(/_/g, "/")),
        (c) => c.charCodeAt(0),
      );
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: key,
        }));
      const response = await fetch("/api/v1/notifications/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...subscription.toJSON(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      if (!response.ok)
        throw Error(
          (await response.json()).message ?? "Device enrollment failed.",
        );
      if (!state.value?.enabled)
        settings.set({
          morning: state.value?.morning ?? "09:00",
          enabled: true,
        });
      setDeviceStatus("This device is ready for notifications.");
    } catch (error) {
      setDeviceStatus((error as Error).message);
    } finally {
      setEnrolling(false);
    }
  }
  return (
    <>
      <SettingsRow
        title="Task alerts"
        help="One setting for all your devices. Each device needs notification permission."
      >
        <Stack gap="3" align="start">
          {state.loading ? (
            <Text role="status">Loading notifications…</Text>
          ) : (
            state.value && (
              <Button
                variant={state.value.enabled ? "outline" : "solid"}
                onClick={() =>
                  settings.set({
                    ...state.value!,
                    enabled: !state.value!.enabled,
                  })
                }
              >
                {state.value.enabled
                  ? "Turn notifications off"
                  : "Turn notifications on"}
              </Button>
            )
          )}
          {state.pending && <Text role="status">Saving…</Text>}
          {state.error && (
            <Text role="alert" color="fg.error" textStyle="sm">
              {state.error}{" "}
              <Button size="sm" variant="ghost" onClick={() => settings.retry()}>
                Retry
              </Button>
            </Text>
          )}
          {(state.undo.length > 0 || state.redo.length > 0) && (
            <HStack gap="2">
              {state.undo.length > 0 && (
                <Button size="sm" variant="ghost" onClick={() => settings.undo()}>
                  Undo
                </Button>
              )}
              {state.redo.length > 0 && (
                <Button size="sm" variant="ghost" onClick={() => settings.redo()}>
                  Redo
                </Button>
              )}
            </HStack>
          )}
        </Stack>
      </SettingsRow>
      {!state.loading && state.value && (
        <SettingsRow
          title="Date-only deadline alerts"
          help="In each device’s current time zone."
        >
          <Field.Root maxW="40">
            <Field.Label htmlFor="notification-morning" srOnly>
              Date-only deadline alerts
            </Field.Label>
            <Input
              id="notification-morning"
              type="time"
              value={state.value.morning}
              onChange={(event) => {
                if (event.target.value)
                  settings.set({
                    ...state.value!,
                    morning: event.target.value,
                  });
              }}
            />
          </Field.Root>
        </SettingsRow>
      )}
      <SettingsRow
        title="This device"
        help="iPhone: add Quantself to your Home Screen, open it there, then enable. Desktop: keep your browser running."
      >
        <Stack gap="3" align="start">
          <Button disabled={enrolling} onClick={() => void enroll()}>
            {enrolling ? "Enabling…" : "Enable notifications on this device"}
          </Button>
          {deviceStatus && <Text role="status" textStyle="sm">{deviceStatus}</Text>}
        </Stack>
      </SettingsRow>
    </>
  );
}
