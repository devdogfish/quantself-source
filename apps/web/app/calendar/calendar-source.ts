import type { ReactNode } from "react";

export type CalendarRange = { from: string; to: string };

export type CalendarItem = { date: string };

export type CalendarSource<Item extends CalendarItem, Context> = {
  load(range: CalendarRange): Item[] | Promise<Item[]>;
  subscribe(onChange: () => void): () => void;
  render(item: Item, context: Context): ReactNode;
  interact?(item: Item): {
    draggable?: boolean;
    resizable?: boolean;
    onOpen?: () => void;
  };
};
