// Drawn for xzor-ui on a 24x24 grid, stroked at 2 with round ends: one path per icon.
export type IconName =
  | "arrow-down"
  | "arrow-up"
  | "bell"
  | "book"
  | "calendar"
  | "cart"
  | "chart"
  | "check"
  | "chevron-down"
  | "chevron-left"
  | "chevron-right"
  | "chevron-up"
  | "clock"
  | "dollar"
  | "dots"
  | "external"
  | "filter"
  | "heart"
  | "home"
  | "inbox"
  | "info"
  | "menu"
  | "minus"
  | "moon"
  | "package"
  | "plus"
  | "search"
  | "share"
  | "sliders"
  | "sun"
  | "tag"
  | "trash"
  | "trending-up"
  | "user"
  | "users"
  | "x";

export const icons: Record<IconName, string> = {
  "arrow-down": "M12 5v14M19 12l-7 7-7-7",
  "arrow-up": "M12 19V5M5 12l7-7 7 7",
  bell: "M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a2 2 0 0 0 3.4 0",
  book: "M4 19V5a2 2 0 0 1 2-2h14v14H6a2 2 0 0 0-2 2zm0 0a2 2 0 0 0 2 2h14v-4",
  calendar: "M5 5h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM4 10h16M8 3v4M16 3v4",
  cart: "M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h9.2a1 1 0 0 0 1-.8L20 8H6.2M9 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM18 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  chart: "M3 3v18h18M8 17v-5M13 17V8M18 17v-9",
  check: "M5 12.5l4.5 4.5L19 7",
  "chevron-down": "M6 9l6 6 6-6",
  "chevron-left": "M15 18l-6-6 6-6",
  "chevron-right": "M9 18l6-6-6-6",
  "chevron-up": "M18 15l-6-6-6 6",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  dollar: "M12 2v20M17 6.5C16 5 14.5 4.5 12 4.5c-3 0-4.5 1.5-4.5 3.5s1.5 3 4.5 3.5 4.5 1.5 4.5 3.5-1.5 3.5-4.5 3.5c-2.5 0-4-.5-5-2",
  dots: "M5 12h.01M12 12h.01M19 12h.01",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  filter: "M3 5h18l-7 8v6l-4 2v-8L3 5z",
  heart: "M12 20s-8-4.5-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 9c0 6.5-8 11-8 11z",
  home: "M3 11l9-8 9 8M5 9.5V21h5v-6h4v6h5V9.5",
  inbox: "M3 13h5l1.5 3h5l1.5-3h5M5.5 5h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6l2.5-8z",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01",
  menu: "M4 6h16M4 12h16M4 18h16",
  minus: "M5 12h14",
  moon: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z",
  package: "M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8",
  plus: "M12 5v14M5 12h14",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5",
  share: "M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M12 3v13M7 8l5-5 5 5",
  sliders: "M4 6h9M17 6h3M15 4v4M4 12h3M11 12h9M9 10v4M4 18h11M19 18h1M17 16v4",
  sun: "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  tag: "M3 12V3h9l9 9-9 9-9-9zM7.5 7.5h.01",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M9 7V4h6v3",
  "trending-up": "M3 17l6-6 4 4 8-8M15 7h6v6",
  user: "M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM5 21v-1a7 7 0 0 1 14 0v1",
  users: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a7 7 0 0 1 14 0v1M16 3.5a4 4 0 0 1 0 7M22 21v-1a6 6 0 0 0-4-5.6",
  x: "M6 6l12 12M18 6L6 18",
};
