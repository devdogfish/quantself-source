import { randomUUID } from "node:crypto";

const { QUANTSELF_UMAMI_URL: origin, UMAMI_ADMIN_PASSWORD: password } = process.env;
if (!origin || !password || password.length < 20) throw Error("Set the Umami URL and a strong admin password.");

const request = (path: string, options?: RequestInit) =>
  fetch(new URL(path, origin), { signal: AbortSignal.timeout(5000), ...options });
const json = (method: string, body: object, token?: string): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) },
  body: JSON.stringify(body),
});
const login = (password: string) => request("/api/auth/login", json("POST", { username: "admin", password }));
let result = await login(password);
if (result.status === 401) {
  const initial = await login("umami");
  if (!initial.ok) throw Error("Cannot log into Umami with the supplied password or the fresh-install default.");
  const { token, user } = await initial.json();
  const rotated = await request(`/api/users/${user.id}`, json("POST", { password }, token));
  if (!rotated.ok) throw Error(`Cannot rotate the initial Umami password (${rotated.status}).`);
  result = await login(password);
}
if (!result.ok) throw Error(`Cannot log into Umami (${result.status}).`);
const { token } = await result.json();
const list = await request("/api/websites", { headers: { Authorization: `Bearer ${token}` } });
if (!list.ok) throw Error("Cannot list Umami websites.");
const { data } = await list.json();
const existing = data.find((site: { domain: string }) => site.domain === "girke.dev");
if (existing) {
  console.log(existing.id);
} else {
  const created = await request("/api/websites", json("POST", { id: randomUUID(), name: "girke.dev", domain: "girke.dev" }, token));
  if (!created.ok) throw Error(`Cannot create the Umami website (${created.status}).`);
  console.log((await created.json()).id);
}
