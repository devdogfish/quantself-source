import { JarvisHistory } from "./jarvis-history";

export default async function JarvisPage({ searchParams }: PageProps<"/jarvis">) {
  const query = await searchParams;
  const c = typeof query.c === "string" ? query.c : null;
  return <JarvisHistory initialId={c} />;
}
