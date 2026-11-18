import type { MetadataRoute } from "next";
export default function manifest(): MetadataRoute.Manifest {
  return { id: "/", name: "Quantself", short_name: "Quantself", description: "Personal systems workspace", start_url: "/todo", display: "standalone", background_color: "#ffffff", theme_color: "#ffffff", icons: [{ src: "/favicon.ico", sizes: "any", type: "image/x-icon", purpose: "any" }] };
}
