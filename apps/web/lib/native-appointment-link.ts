export const appointmentHref = (id: string) => `/todo?appointment=${encodeURIComponent(id)}` as const;
