import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dir = join(root, "target", "tmp-ui");
const slash = (p: string) => p.replaceAll("\\", "/");
const SVG = "http://www.w3.org/2000/svg";
// NavLink resolves its href against the page: happy-dom starts on about:blank.
(window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("http://localhost/");

const kit = ["Stat", "Button", "Sheet", "Dialog", "Menu", "Popover", "Field", "Segmented", "Tabs", "Table", "List", "Glass", "Panel", "Stack", "Grid", "Toolbar", "NavBar", "NavItem", "Avatar", "Skeleton", "Empty", "Icon", "Badge"];

// Every kit component in one app, imported the way a project outside ui/ imports it.
const app = `${kit.map((c) => `@import ${c} from "@source-crafter/xzor-ui/${c}.xzor"`).join("\n")}
@import { type Column } from "@source-crafter/xzor-ui"

@code {
  revenue = 10;
  clicks = 0;
  period = "Week";
  tab = "One";
  picked = "";
  sheet?: Sheet;
  rows = [{ name: "b", total: 2 }, { name: "a", total: 3 }, { name: "c", total: 1 }];
  columns: Column<{ name: string; total: number }>[] = [
    { label: "Name", value: (r) => r.name },
    { label: "Total", value: (r) => r.total, align: "end" },
  ];
}

<Stat label="Revenue" value="@revenue" unit="$" delta="@(-2)" />
<button class="bump" @onclick="() => revenue++">bump</button>
<div class="buttons">
  <Button tone="accent" variant="solid" icon="plus" onClick="() => clicks++">Add</Button>
  <Button icon="x" label="Close" />
  <Button toggles="menu1">Menu</Button>
  <Button opens="sheet1">Open</Button>
  <Button variant="glass" size="lg" disabled="@true">Glass</Button>
</div>
<Menu id="menu1"><button>One</button></Menu>
<Popover id="pop1"><p>Pop</p></Popover>
<Sheet id="sheet1" title="Details" side="end" @ref="sheet"><p>Body</p></Sheet>
<Dialog id="dialog1" title="Confirm">
  <p>Sure?</p>
  @slot actions { <Button closes="dialog1">Cancel</Button> }
</Dialog>
<Field label="Name" error="Required"><input /></Field>
<Field label="Email" hint="We never share it"><input type="email" /></Field>
<Segmented options="@(['Day', 'Week', 'Month'])" @bind-value="period" label="Period" />
<Tabs options="@(['One', 'Two'])" @bind-value="tab" label="Sections" />
<Table items="@rows" columns="@columns" onRow="(r: { name: string; total: number }) => picked = r.name" />
<List items="@(['x', 'y'])" />
<Glass depth="2" tone="accent"><p>glass</p></Glass>
<Panel title="Panel"><p>p</p></Panel>
<Stack direction="row" gap="lg" align="center"><i>1</i></Stack>
<Grid min="10rem"><i>1</i></Grid>
<Toolbar sticky="@true"><i>t</i></Toolbar>
<NavBar kind="tabs"><NavItem href="/" label="Home" icon="home" match="exact" /></NavBar>
<Avatar name="Ada Lovelace" />
<Skeleton width="4rem" />
<Empty title="Nothing here"><p>Add one</p></Empty>
<Badge tone="warning">3</Badge>
<p class="state">@clicks @period @tab @picked</p>
`;

const main = `import "@source-crafter/xzor-ui";
import { mount } from "@source-crafter/xzor-runtime";
import App from "./App.xzor";

mount(App, document.getElementById("app")!);
`;

const xzor = (...args: string[]) => {
  const run = Bun.spawnSync(["cargo", "run", "-q", "--", ...args], { cwd: root });
  return { code: run.exitCode, out: run.stdout.toString() + run.stderr.toString() };
};

const $ = <E extends Element = HTMLElement>(sel: string) => document.querySelector<E>(`#app ${sel}`)!;
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(`#app ${sel}`)];
const state = () => $(".state").textContent;

test("the kit builds into an app outside ui/ and every component renders and reacts", async () => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tsconfig = JSON.parse(readFileSync(join(root, "examples", "counter", "tsconfig.json"), "utf8"));
  tsconfig.compilerOptions.paths = {
    "@source-crafter/xzor-runtime": [slash(join(root, "runtime", "index.ts"))],
    "@source-crafter/xzor-runtime/model": [slash(join(root, "runtime", "model.ts"))],
    "@source-crafter/xzor-ui": [slash(join(root, "ui", "index.ts"))],
    "@source-crafter/xzor-ui/*": [slash(join(root, "ui", ".xzor", "*.ts"))],
  };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
  writeFileSync(join(dir, "App.xzor"), app);
  writeFileSync(join(dir, "main.ts"), main);
  const compiled = xzor("compile", "ui");
  expect(compiled.code, compiled.out).toBe(0);
  const built = xzor("build", dir);
  expect(built.code, built.out).toBe(0);
  const css = readFileSync(join(dir, "dist", "main.css"), "utf8");
  for (const layer of ["xz.tokens", "xz.base", "xz.components", "xz.utilities"]) expect(css).toContain(layer);

  document.body.innerHTML = `<div id="app"></div>`;
  await import(join(dir, "dist", "main.js"));

  // Stat: props given by the app keep following it.
  expect($(".xz-stat strong").textContent).toBe("10$");
  expect($(".xz-stat .xz-badge").dataset["tone"]).toBe("danger");
  $(".bump").click();
  expect($(".xz-stat strong").textContent).toBe("11$");

  // Button: variants as data-*, icons in the SVG namespace, native invokers.
  const [add, close, menu, open, glass] = $$(".buttons .xz-button");
  expect([add!.dataset["tone"], add!.dataset["variant"], add!.getAttribute("type")]).toEqual(["accent", "solid", "button"]);
  expect(add!.querySelector("svg")!.namespaceURI).toBe(SVG);
  expect(add!.querySelector("path")!.getAttribute("d")).toBe("M12 5v14M5 12h14");
  expect(add!.hasAttribute("data-square")).toBe(false);
  add!.click();
  expect(state()).toStartWith("1 ");
  expect([close!.getAttribute("aria-label"), close!.hasAttribute("data-square")]).toEqual(["Close", true]);
  expect(menu!.getAttribute("popovertarget")).toBe("menu1");
  expect([open!.getAttribute("commandfor"), open!.getAttribute("command")]).toEqual(["sheet1", "show-modal"]);
  expect([glass!.dataset["depth"], glass!.dataset["size"], glass!.hasAttribute("disabled")]).toEqual(["1", "lg", true]);
  expect(add!.hasAttribute("data-depth")).toBe(false);

  // Popovers and dialogs.
  expect([$("#menu1").getAttribute("popover"), $("#menu1").dataset["kind"]]).toEqual(["", "menu"]);
  expect($("#pop1").classList.contains("xz-popover")).toBe(true);
  const sheet = $<HTMLDialogElement>("#sheet1");
  expect([sheet.localName, sheet.dataset["side"], sheet.getAttribute("closedby")]).toEqual(["dialog", "end", "any"]);
  const closer = sheet.querySelector<HTMLElement>("header .xz-button")!;
  expect([closer.getAttribute("commandfor"), closer.getAttribute("command")]).toEqual(["sheet1", "close"]);
  expect(sheet.querySelector("footer")).toBeNull();
  expect($("#dialog1 footer .xz-button").getAttribute("command")).toBe("close");

  // Field.
  const [invalid, hinted] = $$(".xz-field");
  expect([invalid!.hasAttribute("data-invalid"), invalid!.querySelector(".xz-field-error")!.textContent]).toEqual([true, "Required"]);
  expect([hinted!.hasAttribute("data-invalid"), hinted!.querySelector(".xz-field-hint")!.textContent]).toEqual([false, "We never share it"]);

  // Segmented and Tabs bind their value.
  const radios = $$(".xz-segmented input") as HTMLInputElement[];
  expect(radios.map((r) => r.checked)).toEqual([false, true, false]);
  expect(new Set(radios.map((r) => r.name)).size).toBe(1);
  radios[2]!.checked = true;
  radios[2]!.dispatchEvent(new Event("change", { bubbles: true }));
  expect(state()).toContain(" Month ");
  const tabs = $$(".xz-tabs [role=tab]");
  tabs[1]!.click();
  expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["false", "true"]);
  expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual(["-1", "0"]);
  tabs[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  expect(state()).toContain(" One ");

  // Table sorts on its headers and reports row clicks.
  const names = () => $$(".xz-table tbody tr").map((tr) => tr.firstElementChild!.textContent);
  expect(names()).toEqual(["b", "a", "c"]);
  $$(".xz-table th button")[0]!.click();
  expect(names()).toEqual(["a", "b", "c"]);
  expect($$(".xz-table th")[0]!.getAttribute("aria-sort")).toBe("ascending");
  $$(".xz-table th button")[0]!.click();
  expect(names()).toEqual(["c", "b", "a"]);
  expect($$(".xz-table td")[1]!.dataset["align"]).toBe("end");
  $$(".xz-table tbody tr")[1]!.click();
  expect(state()).toEndWith(" b");

  // The rest render their class and data-*.
  expect($$(".xz-list li").map((li) => li.textContent)).toEqual(["x", "y"]);
  expect([$(".xz-glass").dataset["depth"], $(".xz-glass").dataset["tone"]]).toEqual(["2", "accent"]);
  expect($(".xz-panel > header h2").textContent).toBe("Panel");
  expect([$(".xz-stack").dataset["direction"], $(".xz-stack").dataset["gap"], $(".xz-stack").dataset["align"]]).toEqual(["row", "lg", "center"]);
  expect($(".xz-grid").getAttribute("style")).toBe("--xz-min: 10rem");
  expect($(".xz-toolbar").hasAttribute("data-sticky")).toBe(true);
  expect([$(".xz-navbar").dataset["kind"], $(".xz-navbar a").getAttribute("href"), $(".xz-navbar a span").textContent]).toEqual(["tabs", "/", "Home"]);
  expect([$(".xz-avatar").textContent!.trim(), $(".xz-avatar").getAttribute("aria-label")]).toEqual(["AL", "Ada Lovelace"]);
  expect($(".xz-skeleton").getAttribute("style")).toBe("--w: 4rem; --h: 1em");
  expect($(".xz-empty h3").textContent).toBe("Nothing here");
  expect($(".xz-empty svg").namespaceURI).toBe(SVG);
}, 180_000);

test("toast stacks a message in a manual popover and removes it after its time", async () => {
  const { toast } = await import(join(root, "ui", "toast.ts"));
  toast("Saved", "success", 20);
  const stack = document.querySelector(".xz-toasts")!;
  expect(stack.getAttribute("popover")).toBe("manual");
  const item = stack.querySelector<HTMLElement>(".xz-toast")!;
  expect([item.textContent, item.dataset["tone"], item.getAttribute("role")]).toEqual(["Saved", "success", "status"]);
  await Bun.sleep(40);
  expect(stack.querySelector(".xz-toast")).toBeNull();
});
