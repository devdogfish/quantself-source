import type { Route } from "next";
import {
  ActivityIcon, BriefcaseBusinessIcon, CalendarDaysIcon, HomeIcon, ListTodoIcon, MicIcon, PackageIcon, TimerResetIcon, WalletIcon,
} from "lucide-react";

export const SECTIONS = [
  { href: "/", icon: HomeIcon, label: "Home" },
  { href: "/todo", icon: ListTodoIcon, label: "To-Do" },
  { href: "/calendar", icon: CalendarDaysIcon, label: "Calendar" },
  { href: "/habits", icon: ListTodoIcon, label: "Habits" },
  { href: "/productivity", icon: TimerResetIcon, label: "Productivity" },
  { href: "/inventory", icon: PackageIcon, label: "Inventory" },
  { href: "/budgeting", icon: WalletIcon, label: "Budgeting" },
  { href: "/jarvis", icon: MicIcon, label: "Jarvis" },
  { href: "/jobs", icon: BriefcaseBusinessIcon, label: "Jobs" },
  { href: "/website-analytics", icon: ActivityIcon, label: "Website analytics" },
] satisfies Array<{ href: Route; icon: typeof HomeIcon; label: string }>;

export const SETTINGS_HREF = "/settings" satisfies Route;

export function isActivePath(pathname: string | null, href: string) {
  if (!pathname) return false;
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
