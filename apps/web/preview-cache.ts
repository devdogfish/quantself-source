export const previewKinds = ["habits", "jobs", "todo", "website-analytics"] as const;
export type PreviewKind = typeof previewKinds[number];

export function previewCacheDirectory(kind: PreviewKind) {
  return `.next/${kind}-preview`;
}

export function nextDevCacheConfig(env: Readonly<Record<string, string | undefined>>) {
  const kind = previewKinds.find(value => value === env.QUANTSELF_NEXT_PREVIEW);
  const habits = env.QUANTSELF_HABITS_PREVIEW === "1" || env.NEXT_PUBLIC_QUANTSELF_HABITS_FIXTURE === "1";
  const preview = kind ?? (habits ? "habits" : undefined);
  return {
    distDir: preview ? previewCacheDirectory(preview) : ".next",
    turbopackFileSystemCacheForDev: !preview && env.QUANTSELF_DEV_TURBOPACK_DISK_CACHE === "1",
  };
}
