# Contracts and Clients Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. After each task's review, dispatch `.github/skills/subagent-driven-development/perf-memory-reviewer-prompt.md`; its blocking findings enter the fix loop like the task reviewer's.

**Goal:** Interfaces implemented by `@Endpoints` classes become contracts: the build generates an HTTP client per contract, registers it in the browser container under `Remote<IContract>`, and `@inject IContract` in a `.xzor` gets that type.

**Architecture:** `Remote<T>` is a type in the runtime's main export. The DI analyzer records which interfaces endpoint classes implement, emits `.xzor/clients/<IContract>.ts`, and registers the client in the browser container (`.xzor/client.ts`) when a view reaches it. The compiler receives the contract names and types `@inject` fields of contracts as `Remote<...>`.

**Tech Stack:** TypeScript 7 analyzer session, Rust codegen, Bun 1.4.

**Spec:** [docs/superpowers/specs/2026-10-26-run-routes-psr-design.md](../superpowers/specs/2026-10-26-run-routes-psr-design.md) (sections Contracts and clients, Endpoints parameters; Touches: DI, Component codegen, LSP).

**Depends on:** the server entry and endpoints plan (endpoint facts, routes, `HttpError`).

## Global Constraints

- `Remote<T>`: each method's result `R` becomes `Promise<Awaited<R>>`; non-method members `never`; parameter names, optionality and doc comments carried over.
- Client methods keep the contract's parameter order: path params into the path (`encodeURIComponent`), `query` into the search string (only defined keys), `body` as JSON with `content-type: application/json`; reads `Response.json()`; 404 resolves `undefined`; any other non-2xx throws `HttpError(status, text)`.
- In `.xzor`: `@inject IContract name` generates `readonly name: Remote<IContract>`. In browser-reached `.ts` services: a parameter typed `IContract` is a build error suggesting `Remote<IContract>`. On the server, `IContract` resolves to the endpoint instance.
- Only clients a view reaches are bundled.

## Review Focus

- A contract method returning `void` / `Promise<void>`: client resolves `undefined` on 204 and 200 with an empty body: test in Task 2.
- A `query` with an optional key left `undefined`: not sent as `"undefined"`: test in Task 2.
- A path param containing `/` or spaces: encoded and decoded back to the same string on the server: test in Task 4.
- Two endpoint classes implementing one contract: build error naming both: test in Task 1.
- A contract a view injects with no `@Endpoints` class implementing it: build error "no @Endpoints class implements IPosts": test in Task 1.

---

### Task 1: `Remote<T>` and contract facts

**Files:**
- Modify: `runtime/index.ts` (export `Remote`), `src/di.ts`, `src/di/model.rs`, `src/di/graph.rs`, `tests/di.test.ts`, `runtime/index.test.ts` (type test with `// @ts-expect-error`)

**Interfaces:**
- Produces: `export type Remote<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never }`; facts `Endpoint.contracts: TypeRef[]`; graph maps contract to endpoint class; diagnostics for two implementations and for an injected contract with no implementation.

- [ ] **Step 1: Write failing tests**: type test: `Remote<{ a(x: number): string; b(): Promise<number> }>` has `a(x: number): Promise<string>` and `b(): Promise<number>`; analyzer: `Posts implements IPosts` yields `contracts: [IPosts]`; a server service taking `IPosts` gets the `Posts` instance in the generated server; the two diagnostics in Review Focus.
- [ ] **Step 2: Run** `bun test ./runtime ./tests/di.test.ts`, expect FAIL. **Step 3: Implement.** **Step 4: Run**, expect PASS.
- [ ] **Step 5: Commit** `feat: Remote<T> and contract facts`.

### Task 2: Generated clients and browser registration

**Files:**
- Modify: `src/di/emit.rs` (write `.xzor/clients/<IContract>.ts`; browser entry registers it), `runtime/index.ts` (`export function call(method: string, path: string, query: Record<string, unknown> | undefined, body: unknown): Promise<unknown>`), `tests/di.test.ts`, `runtime/index.test.ts`

- [ ] **Step 1: Write failing tests**: `call` against a stubbed `fetch`: query skips `undefined`, body JSON, 404 resolves `undefined`, 204 resolves `undefined`, 500 rejects with `HttpError` status 500; generated client for `IPosts` has `get(slug)` calling `call("GET", "/api/posts/" + encodeURIComponent(slug), undefined, undefined)`; a view injecting `IPosts` gets the client registered in `.xzor/client.ts` under `Remote<IPosts>`; a browser-reached `.ts` service taking `IPosts` reports `IPosts is a contract: use Remote<IPosts> in browser code`.
- [ ] **Step 2: Run**, expect FAIL. **Step 3: Implement.** **Step 4: Run**, expect PASS.
- [ ] **Step 5: Commit** `feat(di): generated HTTP clients for contracts`.

### Task 3: `@inject` of a contract in `.xzor`

**Files:**
- Modify: `src/build.rs` (pass contract names from the DI facts into compilation), `src/codegen.rs` (`@inject` field and parameter type), `src/lsp/` (hover through the existing mapping; no new code expected, test only), `tests/lsp.test.ts`

**Interfaces:**
- Consumes: contract names (Task 1).
- Produces: codegen option `contracts: &HashSet<String>`; `@inject IPosts posts` emits `readonly posts: Remote<IPosts>` and imports `Remote` from the runtime.

- [ ] **Step 1: Write failing tests**: codegen unit test for the emitted field with and without the name in `contracts`; LSP test: hover on `posts` in `@inject IPosts posts` shows `Remote<IPosts>`.
- [ ] **Step 2: Run** `cargo test; bun test ./tests/lsp.test.ts`, expect FAIL. **Step 3: Implement**: contracts are known after DI analysis, so a first build compiles, runs DI, and recompiles the `.xzor` files that inject a contract (only those). **Step 4: Run**, expect PASS.
- [ ] **Step 5: Measure** compile time of the blog with and without the recompile pass (`--timings`); the extra pass must touch only files injecting a contract.
- [ ] **Step 6: Commit** `feat(codegen): @inject of a contract is typed Remote<...>`.

### Task 4: Blog end to end and docs

**Files:**
- Modify: `examples/blog` (`contracts/posts.ts` with `IPosts`; `server/api/posts.ts implements IPosts`; pages use `@inject IPosts posts`), `tests/server.test.ts`, `npm/xzor/bin/init.ts` (template with `contracts/`), `README.md`, `docs/design.md` (Server section: contracts), `docs/site/pages`, `npm/xzor/skills/xzor/SKILL.md`, `.github/skills/spec-rehydration/features.md` (paths)

- [ ] **Step 1: Write failing test** in `tests/server.test.ts`: in happy-dom, load the built blog page `/posts/<slug with a space>` against the running `dist/server.js`; the post title renders from the API; the slug round-trips.
- [ ] **Step 2: Run**, expect FAIL. **Step 3: Implement** the blog changes. **Step 4: Run** every command, expect PASS.
- [ ] **Step 5: Commit** `feat: contracts and generated clients; blog uses them`.
