// Extracts DI facts from decorated provider classes and generated components; prints one JSON document.
// Usage: bun di.ts <projectRoot> <file.ts>... -- <component.tszor.ts>...   (paths may be relative to <projectRoot>)
//    or: bun di.ts --serve <projectRoot>, then one {"files","components","overlays"} JSON request per stdin line.
//
// TypeScript 7 sync API calls (proven by the Step 0 spike):
// new API({ cwd }) spawns the bundled tsgo; api.updateSnapshot({ openProjects: [tsconfig] }).getProject(tsconfig) gives { program, checker }.
// program.getSourceFile(path); decorators are the Decorator nodes in classDeclaration.modifiers.
// checker.getSymbolAtLocation(nodes[]) is batched and accepts nodes from several files; checker.getAliasedSymbol(alias) follows imports.
// checker.getSymbolAtLocation(importDeclaration.moduleSpecifier).getExports() gives the runtime's export symbols.
// checker.getTypeFromTypeNode(typeArgument) reads `@Singleton<T>`; checker.getDeclaredTypeOfSymbol(class) is the instance type.
// checker.getTypeOfSymbol(classes[]) then getSignaturesOfType(t, SignatureKind.Construct)[0].getParameters() for constructors.
// checker.getTypeAtLocation(nodes[]) then getSignaturesOfType(t, SignatureKind.Call)[0] and getReturnTypeOfSignature for factories.
// checker.getTypeOfSymbol(parameters[]) is batched; optional ones use getTypeFromTypeNode(annotation) (drops only the implicit undefined); valueDeclaration.resolve() gives `?`/initializer.
// symbol.declarations[0].path + program.getSourceFileMetadataByPath(path).isDefaultLibrary detect lib types without fetching the AST; program.getSourceFileNames() maps the lowercased path back to the real file name.
// checker.resolveName("Promise", SymbolFlags.Type, undefined, false) plus getTypeArguments(reference) unwraps Promise<T>.
// checker.getPropertiesOfType(t): `dispose`, or `__@dispose@N`/`__@asyncDispose@N` compared with the global Disposable/AsyncDisposable members; `?` sets SymbolFlags.Optional.
// checker.isTypeAssignableTo(source, target) is not batched: it runs only for parameters named like a key.
// symbol.getParent() is the module only for exported declarations; parent.getExports() keys are export names ("default" included).
// --serve: new API({ cwd, fs: { readFile, fileExists, directoryExists, getAccessibleEntries } }) serves overlays (undefined falls back to disk). Later requests call
// updateSnapshot({ fileChanges: { changed, created, deleted } }) for changed overlays and mtimes; new files need the tsconfig
// listed as changed to rerun its include globs. The client's parsed-file cache survives such snapshots, so clearSourceFileCache() first.
import { readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { CallExpression, ClassDeclaration, Node, SourceFile } from "typescript/unstable/ast";
import {
  isCallExpression,
  isClassDeclaration,
  isDecorator,
  isIdentifier,
  isImportDeclaration,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isStringLiteral,
} from "typescript/unstable/ast/is";
import {
  API,
  ModifierFlags,
  SignatureKind,
  SymbolFlags,
  TypeFlags,
  type Checker,
  type Program,
  type Signature,
  type Snapshot,
  type Symbol as Sym,
  type Type,
} from "typescript/unstable/sync";

type TypeRef = { id: string; text: string; module: string | null; export: string | null };
type Param = { name: string; optional: boolean; promise: boolean; type: TypeRef; file: string; at: number; badKeys: string[] };
type Dispose = null | "dispose" | "Symbol.dispose" | "Symbol.asyncDispose";
type Registration = {
  lifetime: "singleton" | "scoped" | "transient";
  service: TypeRef;
  impl: TypeRef | null;
  key: string | null;
  factory: { owner: TypeRef; member: string | null } | null;
  async: boolean;
  params: Param[];
  dispose: Dispose;
  disposeOptional: boolean;
  at: number;
};
type Provider = {
  class: TypeRef;
  file: string;
  at: number;
  imports: TypeRef[];
  registrations: Registration[];
  mount: null | { component: TypeRef; target: string; at: number };
};
type Component = { class: TypeRef; injects: Param[] };
type Facts = { providers: Provider[]; components: Component[]; errors: { file: string; at: number; message: string }[] };

type Kind = "ServiceProvider" | "Mount" | "Import" | "Singleton" | "Scoped" | "Transient";
const KINDS: Kind[] = ["ServiceProvider", "Mount", "Import", "Singleton", "Scoped", "Transient"];
const LIFETIMES = { Singleton: "singleton", Scoped: "scoped", Transient: "transient" } as const;
const NAMED = SymbolFlags.Class | SymbolFlags.Interface | SymbolFlags.Enum;
const PRIMITIVE = TypeFlags.String | TypeFlags.Number | TypeFlags.Boolean | TypeFlags.BigInt | TypeFlags.ESSymbol;
const RUNTIME = "@zor/runtime";

type Loc = { sf: SourceFile; node: Node };
type Disposal = { dispose: Dispose; optional: boolean };
const NOT_DISPOSABLE: Disposal = { dispose: null, optional: false };
// Shared by every parameter without a bad key; never mutated.
const NO_KEYS: string[] = [];
// Symbol and type lookups are queued, then answered by one batched request each.
type Lookup<T> = { node: Node; value?: T };

const slash = (p: string) => p.replaceAll("\\", "/");

function analyze(root: string, program: Program, checker: Checker, files: string[], componentFiles: string[]): Facts {
  const facts: Facts = { providers: [], components: [], errors: [] };
  const rel = (fileName: string) => slash(relative(root, fileName));
  const errorAt = (sf: SourceFile, at: number, message: string) => facts.errors.push({ file: rel(sf.fileName), at, message });
  const error = (loc: Loc, message: string) => errorAt(loc.sf, loc.node.getStart(loc.sf), message);
  const source = (file: string) => {
    const sf = program.getSourceFile(file);
    if (!sf) facts.errors.push({ file: rel(file), at: 0, message: `${rel(file)} is not part of the project` });
    return sf;
  };
  const sources = files.map(source).filter((sf) => sf !== undefined);
  const componentSources = componentFiles.map(source).filter((sf) => sf !== undefined);

  // --- symbol helpers ---
  const aliasCache = new Map<number, Sym>();
  const target = (sym: Sym | undefined): Sym | undefined => {
    if (!sym || !(sym.flags & SymbolFlags.Alias)) return sym;
    let t = aliasCache.get(sym.id);
    if (!t) aliasCache.set(sym.id, (t = checker.getAliasedSymbol(sym)));
    return checker.isUnknownSymbol(t) ? undefined : t;
  };
  const symbols = (lookups: Lookup<Sym | undefined>[]) => {
    if (!lookups.length) return;
    const found = checker.getSymbolAtLocation(lookups.map((l) => l.node));
    lookups.forEach((l, i) => (l.value = target(found[i])));
  };

  // --- runtime decorators, by symbol identity with @zor/runtime's exports ---
  const kinds = new Map<number, Kind>();
  for (const sf of [...sources, ...componentSources]) {
    const decl = sf.statements.find((s) => isImportDeclaration(s) && isStringLiteral(s.moduleSpecifier) && s.moduleSpecifier.text === RUNTIME);
    if (!decl || !isImportDeclaration(decl)) continue;
    const exports = checker.getSymbolAtLocation(decl.moduleSpecifier)?.getExports();
    for (const kind of KINDS) {
      const sym = exports?.get(kind as never);
      if (sym) kinds.set(sym.id, kind);
    }
    if (kinds.size) break;
  }

  type Deco = { kind: Kind; call: CallExpression; at: number };
  type Candidate = { sf: SourceFile; cls: ClassDeclaration; calls: { call: CallExpression | undefined; at: number; callee: Lookup<Sym | undefined> }[] };
  const candidates: Candidate[] = [];
  const callees: Lookup<Sym | undefined>[] = [];
  let firstDecorator: { sf: SourceFile; at: number } | undefined;
  for (const sf of sources) {
    for (const cls of sf.statements) {
      if (!isClassDeclaration(cls) || !cls.modifiers) continue;
      const calls: Candidate["calls"] = [];
      for (const m of cls.modifiers) {
        if (!isDecorator(m)) continue;
        const at = m.getStart(sf);
        firstDecorator ??= { sf, at };
        if (!kinds.size) continue;
        const call = isCallExpression(m.expression) ? m.expression : undefined;
        const callee = { node: (call ? call.expression : m.expression) as Node };
        callees.push(callee);
        calls.push({ call, at, callee });
      }
      if (calls.length) candidates.push({ sf, cls, calls });
    }
  }
  if (!kinds.size && firstDecorator) errorAt(firstDecorator.sf, firstDecorator.at, `cannot resolve ${RUNTIME}`);
  symbols(callees);

  // --- plan every provider, queueing the lookups it needs ---
  type RegPlan = {
    deco: Deco;
    key: string | null;
    typeArg: Node | undefined;
    impl?: Lookup<Sym | undefined>;
    owner?: Lookup<Sym | undefined>;
    member?: string | null;
    memberSym?: Lookup<Sym | undefined>;
    factory?: Lookup<Type | undefined>;
    loc: Loc;
  };
  type ProviderPlan = {
    sf: SourceFile;
    cls: ClassDeclaration;
    self: Lookup<Sym | undefined>;
    imports: { lookup: Lookup<Sym | undefined>; loc: Loc }[];
    mount?: { component: Lookup<Sym | undefined>; target: string; at: number; loc: Loc };
    regs: RegPlan[];
  };
  const symLookups: Lookup<Sym | undefined>[] = [];
  const typeLookups: Lookup<Type | undefined>[] = [];
  const sym = (node: Node) => {
    const l = { node };
    symLookups.push(l);
    return l;
  };
  const plans: ProviderPlan[] = [];
  for (const { sf, cls, calls } of candidates) {
    const decos: Deco[] = [];
    for (const c of calls) {
      const kind = c.callee.value && kinds.get(c.callee.value.id);
      if (!kind) continue;
      if (c.call) decos.push({ kind, call: c.call, at: c.at });
      else errorAt(sf, c.at, `@${kind} must be called`);
    }
    if (!decos.length) continue;
    const plan: ProviderPlan = { sf, cls, self: sym(cls.name ?? cls), imports: [], regs: [] };
    for (const deco of decos) {
      const args = deco.call.arguments;
      const loc = { sf, node: deco.call };
      if (deco.kind === "Import") {
        for (const a of args) plan.imports.push({ lookup: sym(a), loc: { sf, node: a } });
      } else if (deco.kind === "Mount") {
        const [component, target] = args;
        if (plan.mount) errorAt(sf, deco.at, "duplicate @Mount");
        else if (!component || !target || !isStringLiteral(target)) error(loc, "@Mount expects a component and a string literal target");
        else plan.mount = { component: sym(component), target: target.text, at: deco.at, loc: { sf, node: component } };
      } else if (deco.kind !== "ServiceProvider") {
        const [first, second] = args;
        const typeArg = deco.call.typeArguments?.[0];
        if (first && isStringLiteral(first)) {
          const fn = second && isIdentifier(second);
          if (!second || (!fn && !isPropertyAccessExpression(second))) {
            error(loc, `@${deco.kind}("${first.text}", ...) expects a function or a static method like Owner.method`);
            continue;
          }
          const factory = { node: second as Node };
          typeLookups.push(factory);
          plan.regs.push({
            deco,
            key: first.text,
            typeArg,
            owner: sym(fn ? second : second.expression),
            member: fn ? null : second.name.text,
            memberSym: fn ? undefined : sym(second.name),
            factory,
            loc: { sf, node: second },
          });
        } else if (first) {
          plan.regs.push({ deco, key: null, typeArg, impl: sym(first), loc: { sf, node: first } });
        } else error(loc, `@${deco.kind} expects an implementation class or a key and a factory`);
      }
    }
    plans.push(plan);
  }
  type ComponentPlan = { sf: SourceFile; cls: ClassDeclaration; self: Lookup<Sym | undefined> };
  const componentPlans: ComponentPlan[] = [];
  for (const sf of componentSources) {
    const cls = sf.statements.find(
      (s) => isClassDeclaration(s) && (s.modifierFlags & (ModifierFlags.Export | ModifierFlags.Default)) === (ModifierFlags.Export | ModifierFlags.Default),
    );
    if (cls && isClassDeclaration(cls)) componentPlans.push({ sf, cls, self: sym(cls.name ?? cls) });
    else facts.errors.push({ file: rel(sf.fileName), at: 0, message: "no default-exported component class" });
  }
  symbols(symLookups);
  if (typeLookups.length) {
    const types = checker.getTypeAtLocation(typeLookups.map((l) => l.node));
    typeLookups.forEach((l, i) => (l.value = types[i]));
  }

  // --- constructor signatures, one batched type request for every class ---
  const classes = new Map<number, Sym>();
  const isClass = (s: Sym | undefined): s is Sym => !!s && !!(s.flags & SymbolFlags.Class);
  for (const p of plans) for (const r of p.regs) if (isClass(r.impl?.value)) classes.set(r.impl.value.id, r.impl.value);
  for (const c of componentPlans) if (isClass(c.self.value)) classes.set(c.self.value.id, c.self.value);
  const ctors = new Map<number, Signature | undefined>();
  const classList = [...classes.values()];
  if (classList.length) {
    const ctorTypes = checker.getTypeOfSymbol(classList);
    classList.forEach((c, i) => {
      const t = ctorTypes[i];
      ctors.set(c.id, t && checker.getSignaturesOfType(t, SignatureKind.Construct)[0]);
    });
  }

  // --- parameters: collect every signature's parameter symbols, then one batched type request ---
  type ParamPlan = { out: Param[]; params: readonly Sym[] };
  const paramPlans: ParamPlan[] = [];
  const paramsOf = (sig: Signature | undefined): Param[] => {
    const out: Param[] = [];
    const params = sig?.getParameters() ?? [];
    if (params.length) paramPlans.push({ out, params });
    return out;
  };

  let promiseId: number | undefined;
  const unwrapPromise = (t: Type): Type | undefined => {
    const s = t.getSymbol();
    if (!s || s.name !== "Promise" || !t.isTypeReference()) return undefined;
    promiseId ??= checker.resolveName("Promise", SymbolFlags.Type, undefined, false)?.id ?? -1;
    return s.id === promiseId ? checker.getTypeArguments(t)[0] : undefined;
  };

  // Default-lib generics (Map<K, V>, string[]) are global and stay allowed.
  const isGeneric = (t: Type) => {
    if (!t.isTypeReference() || checker.getTypeArguments(t).length === 0) return false;
    const decl = t.getSymbol()?.declarations?.[0];
    return !!decl && !program.getSourceFileMetadataByPath(decl.path)?.isDefaultLibrary;
  };

  const typeRefs = new Map<number, TypeRef>();
  // Handle paths are canonical (lowercased on Windows); the program's file names keep their case.
  let fileNames: Map<string, string> | undefined;
  const fileOf = (path: string) => {
    if (!fileNames) {
      fileNames = new Map();
      const names = program.getSourceFileNames();
      for (const n of names) fileNames.set(n, n);
      // Exact names are registered first, so a case-folded key never shadows one.
      for (const n of names) {
        const lower = n.toLowerCase();
        if (!fileNames.has(lower)) fileNames.set(lower, n);
      }
    }
    return fileNames.get(path) ?? fileNames.get(path.toLowerCase());
  };
  const exportName = (s: Sym, fileName: string): string | undefined => {
    const parent = s.getParent();
    if (parent) return parent.getExports().get(s.escapedName)?.id === s.id ? s.name : undefined;
    // `class X {}; export { X as Y }` leaves X without a parent.
    const sf = program.getSourceFile(fileName);
    for (const [name, e] of (sf && checker.getSymbolAtLocation(sf)?.getExports()) ?? []) {
      if (e.flags & SymbolFlags.Alias && target(e)?.id === s.id) return name as string;
    }
    return undefined;
  };
  const symbolRef = (s: Sym, t: Type, text: string, loc: Loc): TypeRef => {
    const decl = s.declarations?.[0];
    // Default-lib types (Date, Map, HTMLElement, ...) are global: nothing to import.
    if (decl && program.getSourceFileMetadataByPath(decl.path)?.isDefaultLibrary) return { id: text, text, module: null, export: null };
    const fileName = decl && s.flags & NAMED ? fileOf(decl.path) : undefined;
    if (!fileName) return nonImportable(t, text, loc);
    const file = rel(fileName).replace(/^\.zor\//, "");
    const module = file.replace(/\.(d\.)?[cm]?tsx?$/, "");
    const name = exportName(s, fileName);
    if (name === undefined) {
      error(loc, `${text} must be exported to be injected`);
      return { id: `${file}#${s.name}`, text, module, export: null };
    }
    return { id: `${file}#${name}`, text, module, export: name };
  };
  const nonImportable = (t: Type, text: string, loc: Loc): TypeRef => {
    if (!(t.flags & PRIMITIVE)) error(loc, `${text} must be a class, interface or enum to be injected`);
    return { id: text, text, module: null, export: null };
  };
  const typeRef = (t: Type, loc: Loc): TypeRef => {
    let ref = typeRefs.get(t.id);
    if (!ref) {
      const text = checker.typeToString(t);
      const s = t.getSymbol();
      typeRefs.set(t.id, (ref = s && !(t.flags & PRIMITIVE) ? symbolRef(s, t, text, loc) : nonImportable(t, text, loc)));
    }
    return ref;
  };
  const classRef = (s: Sym, loc: Loc): TypeRef => typeRef(checker.getDeclaredTypeOfSymbol(s), loc);
  // A module-level function (or callable const) used as a factory: the generated code imports and calls it.
  const functionRef = (s: Sym, loc: Loc): TypeRef | undefined => {
    const decl = s.declarations?.[0];
    const fileName = decl && fileOf(decl.path);
    const name = fileName && exportName(s, fileName);
    if (!fileName || name === undefined) {
      error(loc, `${s.name} must be exported to be used as a factory`);
      return undefined;
    }
    const file = rel(fileName).replace(/^\.zor\//, "");
    return { id: `${file}#${name}`, text: name, module: file.replace(/\.(d\.)?[cm]?tsx?$/, ""), export: name };
  };

  let wellKnown: { dispose?: string; asyncDispose?: string } | undefined;
  const memberName = (global: string) => {
    const g = checker.resolveName(global, SymbolFlags.Type, undefined, false);
    return g && (checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(g))[0]?.escapedName as string | undefined);
  };
  const disposeCache = new Map<number, Disposal>();
  const disposal = (t: Type): Disposal => {
    let d = disposeCache.get(t.id);
    if (d) return d;
    let sync: Sym | undefined;
    let symbolDispose: Sym | undefined;
    let asyncDispose: Sym | undefined;
    const callable = (p: Sym) => {
      let pt = checker.getTypeOfSymbol(p);
      // `dispose?()` is typed `(() => void) | undefined`.
      if (pt && p.flags & SymbolFlags.Optional) pt = checker.getNonNullableType(pt);
      return !!pt && checker.getSignaturesOfType(pt, SignatureKind.Call).length > 0;
    };
    for (const p of checker.getPropertiesOfType(t)) {
      if (p.name === "dispose") {
        if (!sync && callable(p)) sync = p;
      } else if (p.name.startsWith("__@")) {
        wellKnown ??= { dispose: memberName("Disposable"), asyncDispose: memberName("AsyncDisposable") };
        if (p.escapedName === wellKnown.asyncDispose) {
          if (callable(p)) asyncDispose = p;
        } else if (p.escapedName === wellKnown.dispose && !symbolDispose && callable(p)) symbolDispose = p;
      }
    }
    const member = asyncDispose ?? sync ?? symbolDispose;
    d = member
      ? { dispose: asyncDispose ? "Symbol.asyncDispose" : sync ? "dispose" : "Symbol.dispose", optional: !!(member.flags & SymbolFlags.Optional) }
      : NOT_DISPOSABLE;
    disposeCache.set(t.id, d);
    return d;
  };

  // --- build ---
  type Pending = { reg: Registration; type: Type | undefined; serviceLoc: Loc; typeArg: Node | undefined; sf: SourceFile; id: string };
  const pendings: Pending[] = [];
  for (const p of plans) {
    const self = p.self.value;
    if (!self) continue;
    const provider: Provider = {
      class: classRef(self, { sf: p.sf, node: p.cls.name ?? p.cls }),
      file: rel(p.sf.fileName),
      at: (p.cls.name ?? p.cls).getStart(p.sf),
      imports: [],
      registrations: [],
      mount: null,
    };
    for (const i of p.imports) {
      if (isClass(i.lookup.value)) provider.imports.push(classRef(i.lookup.value, i.loc));
      else error(i.loc, "@Import expects a provider class");
    }
    if (p.mount) {
      const c = p.mount.component.value;
      if (isClass(c)) provider.mount = { component: classRef(c, p.mount.loc), target: p.mount.target, at: p.mount.at };
      else error(p.mount.loc, "@Mount expects a component class");
    }
    for (const r of p.regs) {
      const lifetime = LIFETIMES[r.deco.kind as keyof typeof LIFETIMES];
      let type: Type | undefined;
      let reg: Registration;
      if (r.impl) {
        const impl = r.impl.value;
        if (!isClass(impl)) {
          error(r.loc, `@${r.deco.kind} expects a class`);
          continue;
        }
        type = checker.getDeclaredTypeOfSymbol(impl);
        const d = disposal(type);
        reg = {
          lifetime,
          service: undefined!,
          impl: typeRef(type, r.loc),
          key: r.key,
          factory: null,
          async: false,
          params: paramsOf(ctors.get(impl.id)),
          dispose: d.dispose,
          disposeOptional: d.optional,
          at: r.deco.at,
        };
      } else {
        const owner = r.owner!.value;
        const member = r.memberSym?.value?.valueDeclaration?.resolve();
        if (r.member?.startsWith("#") || (member && member.modifierFlags & (ModifierFlags.Private | ModifierFlags.Protected))) {
          error(r.loc, `${owner?.name ?? r.owner!.node.getText(r.loc.sf)}.${r.member} must be public`);
          continue;
        }
        const sig = r.factory!.value && checker.getSignaturesOfType(r.factory!.value, SignatureKind.Call)[0];
        const ret = sig && checker.getReturnTypeOfSignature(sig);
        const fn = r.member === null;
        if (fn ? !owner || !(owner.flags & (SymbolFlags.Function | SymbolFlags.Variable)) || !ret : !isClass(owner) || !ret) {
          error(r.loc, `@${r.deco.kind}("${r.key}", ...) expects a function or a static method of a class`);
          continue;
        }
        const ownerRef = fn ? functionRef(owner!, r.loc) : classRef(owner!, { sf: r.loc.sf, node: r.owner!.node });
        if (!ownerRef) continue;
        const awaited = unwrapPromise(ret);
        type = awaited ?? ret;
        const d = disposal(type);
        reg = {
          lifetime,
          service: undefined!,
          impl: null,
          key: r.key,
          factory: { owner: ownerRef, member: r.member! },
          async: awaited !== undefined,
          params: paramsOf(sig),
          dispose: d.dispose,
          disposeOptional: d.optional,
          at: r.deco.at,
        };
      }
      pendings.push({ reg, type, serviceLoc: r.loc, typeArg: r.typeArg, sf: p.sf, id: `${provider.class.id}:${provider.registrations.length}` });
      provider.registrations.push(reg);
    }
    facts.providers.push(provider);
  }
  // Keyed registrations by key: their `badKeys` id and service type.
  const keyed = new Map<string, { id: string; type: Type }[]>();
  for (const pending of pendings) {
    const declared = pending.typeArg && checker.getTypeFromTypeNode(pending.typeArg as never);
    const loc = declared ? { sf: pending.sf, node: pending.typeArg! } : pending.serviceLoc;
    const service = (declared || pending.type)!;
    if (isGeneric(service)) error(loc, `generic service types are not supported: ${checker.typeToString(service)}`);
    else if (pending.reg.impl && pending.type && isGeneric(pending.type)) {
      error(pending.serviceLoc, `generic service types are not supported: ${checker.typeToString(pending.type)}`);
    }
    pending.reg.service = typeRef(service, loc);
    const key = pending.reg.key;
    if (key !== null) {
      const list = keyed.get(key);
      if (list) list.push({ id: pending.id, type: service });
      else keyed.set(key, [{ id: pending.id, type: service }]);
    }
  }
  for (const c of componentPlans) {
    const self = c.self.value;
    if (!isClass(self)) continue;
    facts.components.push({ class: classRef(self, { sf: c.sf, node: c.cls.name ?? c.cls }), injects: paramsOf(ctors.get(self.id)) });
  }

  const allParams = paramPlans.flatMap((p) => p.params);
  if (allParams.length) {
    const types = checker.getTypeOfSymbol(allParams);
    let i = 0;
    for (const { out, params } of paramPlans) {
      for (const param of params) {
        let t = types[i++];
        const decl = param.valueDeclaration?.resolve();
        const sf = decl?.getSourceFile();
        const optional = !!decl && isParameterDeclaration(decl) && (!!decl.questionToken || !!decl.initializer);
        if (!t || !decl || !sf) {
          if (sf && decl) error({ sf, node: decl }, `cannot resolve the type of parameter ${param.name}`);
          continue;
        }
        // The annotation excludes the implicit `undefined` of `x?: T` without dropping a written `null`.
        if (optional && isParameterDeclaration(decl) && decl.type) t = checker.getTypeFromTypeNode(decl.type as never) ?? t;
        const awaited = unwrapPromise(t);
        let badKeys = NO_KEYS;
        const candidates = keyed.get(param.name);
        if (candidates) {
          let target = awaited ?? t;
          if (optional) target = checker.getNonNullableType(target) ?? target;
          for (const c of candidates) {
            if (!checker.isTypeAssignableTo(c.type, target)) (badKeys === NO_KEYS ? (badKeys = []) : badKeys).push(c.id);
          }
        }
        const name = isParameterDeclaration(decl) ? decl.name : decl;
        out.push({
          name: param.name,
          optional,
          promise: awaited !== undefined,
          type: typeRef(awaited ?? t, { sf, node: decl }),
          file: rel(sf.fileName),
          at: name.getStart(sf),
          badKeys,
        });
      }
    }
  }
  return facts;
}

const args = process.argv.slice(2);
if (args[0] === "--serve") await serve(args[1]);
else oneShot(args);

function oneShot([rootArg, ...rest]: string[]) {
  if (!rootArg) throw new Error("usage: bun di.ts <projectRoot> <file.ts>... -- <component.tszor.ts>...  |  bun di.ts --serve <projectRoot>");
  const root = slash(resolve(rootArg));
  const sep = rest.indexOf("--");
  const toPath = (f: string) => slash(resolve(root, f));
  const files = (sep < 0 ? rest : rest.slice(0, sep)).map(toPath);
  const components = sep < 0 ? [] : rest.slice(sep + 1).map(toPath);
  const config = `${root}/tsconfig.json`;
  const api = new API({ cwd: root });
  try {
    const project = api.updateSnapshot({ openProjects: [config] }).getProject(config);
    if (!project) throw new Error(`no TypeScript project for ${config}`);
    process.stdout.write(JSON.stringify(analyze(root, project.program, project.checker, files, components)));
  } finally {
    api.close();
  }
}

// One JSON request per stdin line, one Facts JSON (or `{"fatal": message}`) per stdout line.
async function serve(rootArg: string | undefined) {
  if (!rootArg) throw new Error("usage: bun di.ts --serve <projectRoot>");
  const root = slash(resolve(rootArg));
  const config = `${root}/tsconfig.json`;
  const toPath = (f: string) => slash(resolve(root, f));
  // The server's paths keep their case but compare case-insensitively on Windows.
  const key = process.platform === "win32" ? (p: string) => p.toLowerCase() : (p: string) => p;
  const mtime = (p: string) => statSync(p, { throwIfNoEntry: false })?.mtimeMs;
  type Overlay = { path: string; text: string };
  let overlays = new Map<string, Overlay>();
  // Non-node_modules program files (and the tsconfig) with their mtime at the last snapshot.
  const tracked = new Map<string, { path: string; mtime: number | undefined }>();
  // Requested files outside the program at the last snapshot, with their mtime then.
  const missing = new Map<string, number | undefined>();
  // Overlays absent from disk (an unsaved component's generated file): directory listings must show them for the include globs.
  let virtual: Overlay[] = [];
  const entries = (dir: string) => {
    const d = key(slash(dir)).replace(/\/$/, "");
    let extra: { files: string[]; directories: string[] } | undefined;
    for (const o of virtual) {
      if (!key(o.path).startsWith(`${d}/`)) continue;
      const rest = o.path.slice(d.length + 1);
      const sep = rest.indexOf("/");
      extra ??= { files: [], directories: [] };
      (sep < 0 ? extra.files : extra.directories).push(sep < 0 ? rest : rest.slice(0, sep));
    }
    if (!extra) return undefined;
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) (e.isDirectory() ? extra.directories : extra.files).push(e.name);
    } catch {}
    return { files: [...new Set(extra.files)], directories: [...new Set(extra.directories)] };
  };
  const api = new API({
    cwd: root,
    fs: {
      readFile: (f) => overlays.get(key(f))?.text,
      fileExists: (f) => (overlays.has(key(f)) ? true : undefined),
      directoryExists: (d) => (virtual.some((o) => key(o.path).startsWith(`${key(slash(d)).replace(/\/$/, "")}/`)) ? true : undefined),
      getAccessibleEntries: entries,
    },
  });
  let snapshot: Snapshot | undefined;
  for await (const line of console) {
    if (!line.trim()) continue;
    try {
      const request = JSON.parse(line) as { files?: string[]; components?: string[]; overlays?: Record<string, string> };
      const files = (request.files ?? []).map(toPath);
      const components = (request.components ?? []).map(toPath);
      const next = new Map<string, Overlay>();
      for (const [file, text] of Object.entries(request.overlays ?? {})) {
        const path = toPath(file);
        next.set(key(path), { path, text });
      }
      const changed: string[] = [];
      const created: string[] = [];
      const deleted: string[] = [];
      for (const [k, o] of next) if (overlays.get(k)?.text !== o.text) changed.push(o.path);
      for (const [k, o] of overlays) if (!next.has(k)) changed.push(o.path);
      overlays = next;
      virtual = [...next.values()].filter((o) => mtime(o.path) === undefined);
      let reglob = false;
      if (snapshot) {
        for (const [k, t] of tracked) {
          const m = mtime(t.path);
          if (m === undefined && !overlays.has(k)) {
            deleted.push(t.path);
            tracked.delete(k);
            reglob = true;
          } else if (m !== t.mtime) {
            t.mtime = m;
            if (t.path === config) reglob = true;
            else changed.push(t.path);
          }
        }
        // A requested file the program lacks was created since: the tsconfig's include globs must rerun.
        for (const f of [...files, ...components]) {
          const k = key(f);
          if (tracked.has(k) || (missing.has(k) && missing.get(k) === mtime(f))) continue;
          created.push(f);
          reglob = true;
        }
        if (reglob) changed.push(config);
      }
      const rebuilt = !snapshot || changed.length > 0 || created.length > 0 || deleted.length > 0;
      if (rebuilt) {
        const first = !snapshot;
        snapshot?.dispose();
        // The client keeps parsed files across snapshots unless the server reports them changed, which it does not for these edits.
        api.clearSourceFileCache();
        snapshot = first ? api.updateSnapshot({ openProjects: [config] }) : api.updateSnapshot({ fileChanges: { changed, created, deleted } });
        const names = snapshot.getProject(config)?.program.getSourceFileNames() ?? [];
        const live = new Set<string>([key(config)]);
        if (!tracked.has(key(config))) tracked.set(key(config), { path: config, mtime: mtime(config) });
        for (const n of names) {
          if (n.includes("/node_modules/")) continue;
          const k = key(n);
          live.add(k);
          if (!tracked.has(k)) tracked.set(k, { path: n, mtime: mtime(n) });
        }
        for (const k of tracked.keys()) if (!live.has(k)) tracked.delete(k);
        missing.clear();
        for (const f of [...files, ...components]) if (!tracked.has(key(f))) missing.set(key(f), mtime(f));
      }
      const project = snapshot.getProject(config);
      if (!project) throw new Error(`no TypeScript project for ${config}`);
      // `rebuilt` is a debug signal; the Rust side ignores it.
      process.stdout.write(JSON.stringify({ ...analyze(root, project.program, project.checker, files, components), rebuilt }) + "\n");
    } catch (e) {
      process.stdout.write(JSON.stringify({ fatal: e instanceof Error ? (e.stack ?? e.message) : String(e) }) + "\n");
    }
  }
  snapshot?.dispose();
  api.close();
}
