/** URL() repairs malformed schemes such as https:dsl; navigation must reject them. */
export function taskUrlHref(value: string) {
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  value = value.replace(/^ +| +$/g, "");
  if (!value || /\s/.test(value)) return null;
  const explicit = /^https?:\/\//i.test(value);
  const bare = /^(?:localhost(?::\d+)?|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(?::\d+)?(?:[/?#]\S*)?$/i.test(value);
  if (!explicit && !bare) return null;
  try {
    const url = new URL(explicit ? value : `https://${value}`);
    return ["http:", "https:"].includes(url.protocol) && url.hostname && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
/** Arbitrary strings remain saveable; only recognized web addresses normalize. */
export function normalizeTaskUrl(value: string) {
  const href = taskUrlHref(value);
  const text = value.replace(/^ +| +$/g, "");
  return href ? (/^https?:\/\//i.test(text) ? text : `https://${text}`) : value;
}

export function taskUrlHrefs(value: string): string[] {
  return value.split(/\r?\n/).flatMap(row => {
    const href = taskUrlHref(row);
    return href ? [href] : [];
  });
}
