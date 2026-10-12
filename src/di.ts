// Extracts DI facts from decorated provider classes and generated components; prints one JSON document.
// Usage: bun di.ts <projectRoot> <file.ts>... -- <component.tszor.ts>...   (paths may be relative to <projectRoot>)
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
// checker.getPropertiesOfType(t): `dispose`, or `__@dispose@N`/`__@asyncDispose@N` compared with the global Disposable/AsyncDisposable members.
// symbol.getParent() is the module only for exported declarations; parent.getExports() keys are export names ("default" included).
import { relative, resolve } from "node:path";
import type { CallExpression, ClassDeclaration, Node, SourceFile } from "typescript/unstable/ast";
import {
  isCallExpression,
  isClassDeclaration,
  isDecorator,
  isImportDeclaration,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isStringLiteral,
} from "typescript/unstable/ast/is";
import { API, ModifierFlags, SignatureKind, SymbolFlags, TypeFlags, type Checker, type Program, type Signature, type Symbol as Sym, type Type } from "typescript/unstable/sync";

type TypeRef = { id: string; text: string; module: string | null; export: string | null };
type Param = { name: string; optional: boolean; promise: boolean; type: TypeRef };
type Dispose = null | "dispose" | "Symbol.dispose" | "Symbol.asyncDispose";
type Registration = {
  lifetime: "singleton" | "scoped" | "transient";
  service: TypeRef;
  impl: TypeRef | null;
  key: string | null;
  factory: { owner: TypeRef; member: string } | null;
  async: boolean;
  params: Param[];
  dispose: Dispose;
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
    member?: string;
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
          if (!second || !isPropertyAccessExpression(second)) {
            error(loc, `@${deco.kind}("${first.text}", ...) expects a static method reference like Owner.method`);
            continue;
          }
          const factory = { node: second as Node };
          typeLookups.push(factory);
          plan.regs.push({
            deco,
            key: first.text,
            typeArg,
            owner: sym(second.expression),
            member: second.name.text,
            memberSym: sym(second.name),
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

  const isGeneric = (t: Type) => t.isTypeReference() && checker.getTypeArguments(t).length > 0;

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

  let wellKnown: { dispose?: string; asyncDispose?: string } | undefined;
  const memberName = (global: string) => {
    const g = checker.resolveName(global, SymbolFlags.Type, undefined, false);
    return g && (checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(g))[0]?.escapedName as string | undefined);
  };
  const disposeCache = new Map<number, Dispose>();
  const disposal = (t: Type): Dispose => {
    let d = disposeCache.get(t.id);
    if (d !== undefined) return d;
    let sync = false;
    let symbolDispose = false;
    d = null;
    const callable = (p: Sym) => {
      const pt = checker.getTypeOfSymbol(p);
      return !!pt && checker.getSignaturesOfType(pt, SignatureKind.Call).length > 0;
    };
    for (const p of checker.getPropertiesOfType(t)) {
      if (p.name === "dispose") sync ||= callable(p);
      else if (p.name.startsWith("__@")) {
        wellKnown ??= { dispose: memberName("Disposable"), asyncDispose: memberName("AsyncDisposable") };
        if (p.escapedName === wellKnown.asyncDispose) {
          if (callable(p)) d = "Symbol.asyncDispose";
        } else if (p.escapedName === wellKnown.dispose) symbolDispose ||= callable(p);
      }
    }
    d ??= sync ? "dispose" : symbolDispose ? "Symbol.dispose" : null;
    disposeCache.set(t.id, d);
    return d;
  };

  // --- build ---
  type Pending = { reg: Registration; type: Type | undefined; serviceLoc: Loc; typeArg: Node | undefined; sf: SourceFile };
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
        reg = {
          lifetime,
          service: undefined!,
          impl: typeRef(type, r.loc),
          key: r.key,
          factory: null,
          async: false,
          params: paramsOf(ctors.get(impl.id)),
          dispose: disposal(type),
          at: r.deco.at,
        };
      } else {
        const owner = r.owner!.value;
        const member = r.memberSym!.value?.valueDeclaration?.resolve();
        if (r.member!.startsWith("#") || (member && member.modifierFlags & ModifierFlags.Private)) {
          error(r.loc, `${owner?.name ?? r.owner!.node.getText(r.loc.sf)}.${r.member} must not be private`);
          continue;
        }
        const sig = r.factory!.value && checker.getSignaturesOfType(r.factory!.value, SignatureKind.Call)[0];
        const ret = sig && checker.getReturnTypeOfSignature(sig);
        if (!isClass(owner) || !ret) {
          error(r.loc, `@${r.deco.kind}("${r.key}", ...) expects a static method of a class`);
          continue;
        }
        const awaited = unwrapPromise(ret);
        type = awaited ?? ret;
        reg = {
          lifetime,
          service: undefined!,
          impl: null,
          key: r.key,
          factory: { owner: classRef(owner, { sf: r.loc.sf, node: r.owner!.node }), member: r.member! },
          async: awaited !== undefined,
          params: paramsOf(sig),
          dispose: disposal(type),
          at: r.deco.at,
        };
      }
      pendings.push({ reg, type, serviceLoc: r.loc, typeArg: r.typeArg, sf: p.sf });
      provider.registrations.push(reg);
    }
    facts.providers.push(provider);
  }
  for (const pending of pendings) {
    const declared = pending.typeArg && checker.getTypeFromTypeNode(pending.typeArg as never);
    const loc = declared ? { sf: pending.sf, node: pending.typeArg! } : pending.serviceLoc;
    const service = (declared || pending.type)!;
    if (isGeneric(service)) error(loc, `generic service types are not supported: ${checker.typeToString(service)}`);
    else if (pending.reg.impl && pending.type && isGeneric(pending.type)) {
      error(pending.serviceLoc, `generic service types are not supported: ${checker.typeToString(pending.type)}`);
    }
    pending.reg.service = typeRef(service, loc);
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
        out.push({ name: param.name, optional, promise: awaited !== undefined, type: typeRef(awaited ?? t, { sf, node: decl }) });
      }
    }
  }
  return facts;
}

const [rootArg, ...rest] = process.argv.slice(2);
if (!rootArg) throw new Error("usage: bun di.ts <projectRoot> <file.ts>... -- <component.tszor.ts>...");
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
