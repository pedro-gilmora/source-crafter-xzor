import { expect, test } from "bun:test";
import { composeMaps, decodeMappings, encodeMappings } from "../src/bundle";

test("VLQ mappings round-trip", () => {
  const lines = [[[0, 0, 1, 2], [4]], [], [[2, 0, 0, 0]]];
  expect(decodeMappings(encodeMappings(lines))).toEqual(lines);
});

test("bundle maps are composed with the .xzor maps behind generated files", () => {
  // bundle.js line 0 col 10 comes from gen.ts line 1 col 4; gen.ts line 1 col 2..8 comes from App.xzor line 3 col 0.
  const outer = {
    version: 3,
    sources: ["../.xzor/gen.ts", "../main.ts"],
    sourcesContent: ["x", "y"],
    names: [],
    mappings: encodeMappings([[[10, 0, 1, 4], [20, 1, 0, 0]]]),
  };
  const inner = {
    version: 3,
    sources: ["App.xzor"],
    sourcesContent: ["@code {}\n\n\n<p/>"],
    names: [],
    mappings: encodeMappings([[], [[0], [2, 0, 3, 0], [8]]]),
  };
  const out = composeMaps(outer, (source) => (source === "../.xzor/gen.ts" ? { map: inner, dir: "../.xzor" } : undefined));
  expect(out.sources).toEqual(["../.xzor/App.xzor", "../main.ts"]);
  expect(out.sourcesContent).toEqual(["@code {}\n\n\n<p/>", "y"]);
  expect(decodeMappings(out.mappings)).toEqual([[[10, 0, 3, 2], [20, 1, 0, 0]]]);
});
