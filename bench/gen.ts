// Generates a synthetic xzor project for build benchmarks: `bun bench/gen.ts <dir> <components>`.
// Each component imports two earlier ones and every tenth inherits a shared .ts base.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const [dir = "target/bench/app", count = "400"] = process.argv.slice(2);
const n = Number(count);
const root = join(import.meta.dir, "..");
rmSync(dir, { recursive: true, force: true });
mkdirSync(join(dir, "c"), { recursive: true });
const runtime = relative(dir, join(root, "runtime", "index.ts")).replaceAll("\\", "/");
writeFileSync(
  join(dir, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      lib: ["ES2022", "ESNext.Disposable", "DOM"],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      rootDirs: [".", ".xzor"],
      paths: { "@source-crafter/xzor-runtime": [runtime] },
    },
    include: ["**/*.ts", ".xzor/**/*.ts"],
  }),
);
writeFileSync(
  join(dir, "c", "Base.ts"),
  `import { ComponentBase } from "@source-crafter/xzor-runtime";\nexport abstract class Base extends ComponentBase {\n  title = "base";\n  shout(s: string) { return s.toUpperCase(); }\n}\n`,
);
for (let i = 0; i < n; i++) {
  const deps = [i - 1, i - 2].filter((d) => d >= 0);
  const imports = deps.map((d) => `@import C${d} from "./C${d}.xzor"`).join("\n");
  const inherit = i % 10 === 0 ? `@import { Base } from "./Base"\n@inherits Base\n` : "";
  const uses = deps.map((d) => `  <C${d} label="from ${i}" n="${i}" />`).join("\n");
  const body = `${imports}\n${inherit}
@code {
  label = "";
  n: number = 0;
  items: string[] = ["a", "b", "c"];
  toggle = false;
  flip() { this.toggle = !this.toggle; }
}

<section class="c${i}">
  <h2>@label @n</h2>
  @if (toggle) { <p>on</p> } else { <p>off</p> }
  @for (const item of items) { <li @key="item">@item</li> }
  <button @onclick="flip">flip</button>
${uses}
</section>
`;
  writeFileSync(join(dir, "c", `C${i}.xzor`), body.replace(/^\n/, ""));
}
writeFileSync(
  join(dir, "main.ts"),
  `import { mount } from "@source-crafter/xzor-runtime";\nimport App from "./c/C${n - 1}.xzor";\nmount(App, document.getElementById("app")!);\n`,
);
console.log(`${n} components in ${dir}`);
