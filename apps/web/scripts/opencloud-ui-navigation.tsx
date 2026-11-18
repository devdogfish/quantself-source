// Synthetic integration-only router adapter; application components remain unchanged.
import { useSyncExternalStore, type AnchorHTMLAttributes } from "react";
const subscribe = (notify: () => void) => { window.addEventListener("popstate", notify); return () => window.removeEventListener("popstate", notify); };
export function usePathname() { return useSyncExternalStore(subscribe, () => window.location.pathname); }
export function useSearchParams() { return new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search)); }
const navigate = (url: string, replace = false) => { window.history[replace ? "replaceState" : "pushState"]({}, "", url); window.dispatchEvent(new PopStateEvent("popstate")); };
export function useRouter() { return { push: (url: string) => navigate(url), replace: (url: string) => navigate(url, true), refresh: () => window.dispatchEvent(new PopStateEvent("popstate")), back: () => window.history.back(), prefetch: () => {} }; }
export function useParams<T>() { return { id: usePathname().split("/").at(-1) } as T; }
export default function Link(props: AnchorHTMLAttributes<HTMLAnchorElement>) { return <a {...props} onClick={event => { if (props.href?.startsWith("/") && !props.target) { event.preventDefault(); navigate(props.href); } }} />; }
