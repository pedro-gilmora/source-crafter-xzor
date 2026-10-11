// One-off generator for syntax.test.tszor: assertions are located by substring, not by hand-counted columns.
type A = [needle: string, scopes: string, nth?: number];
const spec: [string, A[]][] = [
  ['@page "/"', [["@", "keyword.control.transition.tszor"], ["page", "keyword.control.directive.tszor"], ['"/"', "string.quoted.double.tszor"]]],
  ['@import Counter from "./Counter.tszor"', [["@", "keyword.control.transition.tszor"], ["import", "keyword.control.import.ts"], ['"./Counter.tszor"', "string.quoted.double.ts"]]],
  ["@code {", [["@", "keyword.control.transition.tszor"], ["code", "keyword.control.directive.tszor"], ["{", "meta.embedded.block.typescript punctuation.definition.block.ts"]]],
  ["  count: number = 0;", [["count", "meta.embedded.block.typescript variable.object.property.ts"], ["number", "support.type.primitive.ts"]]],
  ["  inc() { this.count++; }", [["inc", "meta.embedded.block.typescript entity.name.function.ts"], ["this", "variable.language.this.ts"]]],
  ["}", [["}", "meta.embedded.block.typescript punctuation.definition.block.ts"]]],
  ['<div class="a @kind" @onclick="() => go(1)">Hi @user.name, @(x + 1) a@b.com @@</div>', [
    ["<", "punctuation.definition.tag.begin.html"],
    ["div", "entity.name.tag.html"],
    ["class", "entity.other.attribute-name.html"],
    ["a", "string.quoted.html", 1],
    ["@", "string.quoted.html keyword.control.transition.tszor"],
    ["kind", "variable.other.readwrite.tszor"],
    ["@onclick", "entity.other.attribute-name.html"],
    ["=>", "meta.embedded.expression.typescript storage.type.function.arrow.ts"],
    ["go", "entity.name.function.ts"],
    ["@", "keyword.control.transition.tszor", 2],
    ["user.name", "variable.other.readwrite.tszor"],
    ["@", "keyword.control.transition.tszor", 3],
    ["x", "meta.embedded.expression.typescript variable.other.readwrite.ts"],
    ["+", "keyword.operator.arithmetic.ts"],
    ["@", "- keyword.control.transition.tszor", 4],
    ["@@", "constant.character.escape.tszor"],
    ["</", "punctuation.definition.tag.begin.html"],
    ["div", "entity.name.tag.html", 1],
  ]],
  ["<p>  <!-- note --></p>", [["<!-- note -->", "comment.block.html"]]],
  ["@if (count > 1) {", [["@", "keyword.control.transition.tszor"], ["if", "keyword.control.tszor"], ["count", "meta.embedded.expression.typescript variable.other.readwrite.ts"], [">", "keyword.operator.relational.ts"], ["{", "punctuation.section.block.begin.tszor"]]],
  ["  <b>big</b>", [["b", "entity.name.tag.html"], ["big", "- entity.name.tag.html"]]],
  ["} else if (count < 0) {", [["}", "punctuation.section.block.end.tszor"], ["else", "keyword.control.tszor"], ["if", "keyword.control.tszor"], ["count", "variable.other.readwrite.ts"], ["<", "keyword.operator.relational.ts"]]],
  ["}", []],
  ["@if (a >= 10 && b <= 2) {}", [[">=", "keyword.operator.relational.ts"], ["<=", "keyword.operator.relational.ts"]]],
  ["<p>@(a < b) @(c > d)</p>", [["<", "keyword.operator.relational.ts", 1], [">", "keyword.operator.relational.ts", 1]]],
  ['<button disabled="@(n < 1)" @onclick="() => n > 0 && go()">x</button>', [["<", "keyword.operator.relational.ts", 1], [">", "keyword.operator.relational.ts", 1]]],
  ["else {", [["else", "keyword.control.tszor"]]],
  ['  <Counter step="@(2)" />', [["Counter", "support.class.component.tszor"], ["step", "entity.other.attribute-name.html"], ["@", "keyword.control.transition.tszor"], ["2", "constant.numeric.decimal.ts"]]],
  ["}", []],
  ["@for (const item of items) {", [["for", "keyword.control.tszor"], ["const", "storage.type.ts"]]],
  ["  <li>@item</li>", [["@", "keyword.control.transition.tszor"], ["item", "variable.other.readwrite.tszor"]]],
  ["}", []],
  ["@switch (kind) {", [["switch", "keyword.control.tszor"]]],
  ['  case "a":', [["case", "keyword.control.tszor"], ['"a"', "string.quoted.double.ts"]]],
  ["    in case of", [["case", "- keyword.control.tszor"]]],
  ["    break;", [["break", "keyword.control.tszor"]]],
  ["  default:", [["default", "keyword.control.tszor"]]],
  ["}", []],
  ["<p>after</p>", [["p", "entity.name.tag.html"]]],
];

const out = ['<!-- SYNTAX TEST "source.tszor" "tszor grammar"'];
for (const [line, asserts] of spec) {
  out.push(line);
  for (const [needle, scopes, nth = 0] of asserts) {
    let col = -1;
    for (let i = 0; i <= nth; i++) col = line.indexOf(needle, col + 1);
    if (col < 0) throw new Error(`${needle} not in ${line}`);
    const len = needle.length;
    out.push(col >= 5 ? `<!--${" ".repeat(col - 4)}${"^".repeat(len)} ${scopes}` : `<!-- <${"~".repeat(col)}${"-".repeat(len)} ${scopes}`);
  }
}
await Bun.write(new URL("./syntax.test.tszor", import.meta.url), out.join("\n") + "\n");
