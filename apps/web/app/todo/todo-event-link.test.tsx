import { afterAll, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { Task } from "./todo-projection";

mock.module("./todo-workspace.module.css", () => ({ default: { eventActions: "event-actions", compactEventActions: "compact-actions", eventAction: "event-action" } }));
afterAll(() => mock.restore());
const { EventLink } = await import("./todo-event-link");
const { ChakraProvider } = await import("@chakra-ui/react");
const { system } = await import("@/components/chakra/system");
const render = (element: ReactNode) => renderToStaticMarkup(<ChakraProvider value={system}>{element}</ChakraProvider>).replace(/<style[^>]*>[\s\S]*?<\/style>/g, "");
const task = { title: "Meeting", eventUrls: [] } as unknown as Task;

test("single URL remains a direct anchor; empty URLs render nothing", () => {
  expect(render(<EventLink task={task} />)).toBe("");
  const html = render(<EventLink task={{ ...task, eventUrls: ["https://example.org/one"] }} />);
  expect(html).toContain('href="https://example.org/one"');
  expect(html).toContain('aria-label="Open link for Meeting"');
  expect(html).not.toContain("<button");
});

test("multiple links render the chooser trigger in calendar and list", () => {
  for (const props of [{}, { compact: true }]) {
    const html = render(<EventLink task={{ ...task, eventUrls: ["https://example.org/one", "https://example.net/two"] }} {...props} />);
    expect(html).toContain("<button");
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-label="Open links for Meeting"');
  }
});


test("map icon encodes stored location, including map-only tasks; blank locations stay hidden", () => {
  const location = "123 Main St, Halifax & Dartmouth #2";
  const html = render(<EventLink task={{ ...task, eventLocation: location }} />);
  expect(html).toContain(`href="https://maps.apple.com/search?query=${encodeURIComponent(location)}"`);
  expect(html).toContain('aria-label="Open map for Meeting"');
  expect(html).toContain('data-task-link-control="true"');
  expect(html).not.toContain("Open link");
  expect(render(<EventLink task={{ ...task, eventLocation: "  \n " }} />)).toBe("");
});

test("link and map icons coexist without visible Open link text", () => {
  for (const eventUrls of [["https://example.org"], ["https://example.org", "https://example.net"]]) {
    const html = render(<EventLink task={{ ...task, eventUrls, eventLocation: "Halifax" }} />);
    expect(html).toContain('aria-label="Open map for Meeting"');
    expect(html).toContain(`aria-label="Open ${eventUrls.length > 1 ? "links" : "link"} for Meeting"`);
    expect(html).not.toMatch(/>Open links?</);
    expect(html.match(/<svg/g)).toHaveLength(2);
  }
});
