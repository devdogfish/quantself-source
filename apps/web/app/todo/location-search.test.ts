import { expect, test } from "bun:test";
import { searchLocations } from "./location-search";

test("location search sends one bounded anonymous request, skips short queries and formats exact addresses", async () => {
  let count = 0;
  const controller = new AbortController();
  const fetcher = (async (url: string, init: RequestInit) => {
    count++;
    const query = new URL(url);
    expect(query.searchParams.get("q")).toBe("Central Library");
    expect(query.searchParams.get("limit")).toBe("5");
    expect(init.credentials).toBe("omit"); expect(init.signal).toBe(controller.signal);
    return Response.json({ features: [
      { properties: { osm_id: 1, osm_type: "W", name: "Central Library", housenumber: "5440", street: "Spring Garden Road", city: "Halifax", state: "Nova Scotia", country: "Canada" } },
      { properties: { osm_id: 2, name: "Central Library", housenumber: "5440", street: "Spring Garden Road", city: "Halifax", state: "Nova Scotia", country: "Canada" } },
      { properties: null },
    ] });
  });
  expect(await searchLocations("ab", controller.signal, fetcher)).toEqual([]);
  expect(count).toBe(0);
  expect(await searchLocations(" Central Library ", controller.signal, fetcher)).toEqual([{ id: "W-1", label: "Central Library, 5440 Spring Garden Road, Halifax, Nova Scotia, Canada" }]);
  expect(count).toBe(1);
});

test("location search caps provider responses and reports failure without retries", async () => {
  const signal = new AbortController().signal;
  const many = (async () => Response.json({ features: Array.from({ length: 30 }, (_, i) => ({ properties: { name: `Place ${i}` } })) }));
  expect(await searchLocations("place", signal, many)).toHaveLength(5);
  let requests = 0;
  await expect(searchLocations("place", signal, (async () => { requests++; return new Response(null, { status: 429 }); }))).rejects.toThrow("Location search unavailable");
  expect(requests).toBe(1);
});

test("Photon suggestions preserve valid point geometry and locality, reject invalid coordinates", async () => {
  const signal = new AbortController().signal;
  const features = [
    { geometry: { type: "Point", coordinates: [-63.57, 44.64] }, properties: { name: "Geometry place", city: "Halifax" } },
    ...[[181, 44], [20, 91], [NaN, 10], ["10", 20]].map((coordinates, index) => ({ geometry: { type: "Point", coordinates }, properties: { name: `Invalid geometry ${index}` } })),
  ];
  const suggestions = await searchLocations("geometry", signal, async () => Response.json({ features }));
  expect(suggestions[0]).toMatchObject({ coordinates: [-63.57, 44.64], locality: "Halifax" });
  expect(suggestions.slice(1).every(item => item.coordinates === undefined)).toBe(true);
});
