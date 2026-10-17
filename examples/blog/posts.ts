export type Block = { h: string } | { p: string } | { code: string } | { quote: string };

export interface Post {
  slug: string;
  title: string;
  summary: string;
  date: string;
  minutes: number;
  tags: string[];
  body: Block[];
}

export const posts: Post[] = [
  {
    slug: "glass-without-javascript",
    title: "Liquid glass without a line of JavaScript",
    summary: "A translucent tint, a light rim, blur and saturation behind: four declarations and a fallback make a surface feel like glass.",
    date: "2026-10-14",
    minutes: 5,
    tags: ["css", "design"],
    body: [
      { p: "Glass is a stack of small effects. Remove any one and it reads as a grey box; get all four right and the surface seems to float above the page." },
      { h: "The four layers" },
      { p: "Behind the surface, `backdrop-filter` blurs and saturates whatever scrolls past. On the surface, a translucent tint keeps text readable, a one-pixel light rim on the top edge catches the light, and a soft shine gradient fades out halfway down." },
      { code: ".glass {\n  background: linear-gradient(165deg, #fff6, #fff0 45%), var(--tint);\n  backdrop-filter: blur(18px) saturate(180%);\n  box-shadow: inset 0 1px 0 #fffe, 0 12px 32px #0002;\n}" },
      { h: "Know when to stop" },
      { p: "Glass needs something colorful behind it, so give the page a soft backdrop. Never nest glass in glass: the inner surface only blurs the outer one, which is already blurred." },
      { quote: "Every blurred surface costs the compositor. Three on screen is plenty." },
      { p: "Finally, respect people who asked for less: `prefers-reduced-transparency` and browsers without `backdrop-filter` get a solid surface instead." },
    ],
  },
  {
    slug: "popovers-that-open-themselves",
    title: "Popovers and sheets that open themselves",
    summary: "With popovertarget, command and commandfor, a button opens a menu or a modal sheet without a click handler, and the browser handles focus and Escape.",
    date: "2026-10-09",
    minutes: 4,
    tags: ["css", "html"],
    body: [
      { p: "For years a menu meant state: an `open` flag, a click handler, an outside-click listener and a focus trap. The platform now does all of it." },
      { h: "Invoker buttons" },
      { code: '<button popovertarget="more">More</button>\n<div id="more" popover>…</div>\n\n<button commandfor="cart" command="show-modal">Cart</button>\n<dialog id="cart" closedby="any">…</dialog>' },
      { p: "The popover sits in the top layer, closes on outside clicks and Escape, and is anchored to its invoker with `position-area`. The dialog traps focus and returns it when it closes." },
      { h: "Animating in and out" },
      { p: "`@starting-style` gives the first frame, and `transition-behavior: allow-discrete` keeps the element visible until its exit transition ends." },
    ],
  },
  {
    slug: "page-transitions-for-free",
    title: "Page transitions for free",
    summary: "The View Transitions API crossfades between two renders. Name the elements both pages share, and they morph into place.",
    date: "2026-10-02",
    minutes: 3,
    tags: ["css", "motion"],
    body: [
      { p: "A router change is two renders of the same document. Wrap the update in `document.startViewTransition` and the browser animates between snapshots." },
      { code: "/* the card title on the list and the heading of the post */\n.card h2 { view-transition-name: var(--name); }" },
      { p: "Give an element the same `view-transition-name` on both pages and it moves and resizes into its new place. Everything else crossfades." },
      { quote: "Turn it off under prefers-reduced-motion: the content should simply appear." },
    ],
  },
  {
    slug: "components-that-measure-their-box",
    title: "Components that measure their own box",
    summary: "Container queries let a card change its layout by the space it gets, not by the width of the window.",
    date: "2026-09-25",
    minutes: 4,
    tags: ["css", "layout"],
    body: [
      { p: "Media queries ask about the window. A card in a sidebar and the same card in the main column live in very different boxes." },
      { code: ".card-box { container-type: inline-size; }\n\n@container (width > 30rem) {\n  .card { grid-template-columns: 8rem 1fr; }\n}" },
      { p: "Mark the wrapper as a container and the card adapts wherever it lands: one column when narrow, image beside text when wide." },
    ],
  },
];

export const tags = [...new Set(posts.flatMap((p) => p.tags))].sort();

export const day = (iso: string): string => new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
