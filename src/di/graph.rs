//! Resolves the dependency graph from the analyzer facts.

use std::collections::{HashMap, HashSet};

use super::model::{Component, Facts, Lifetime, Param, Provider, Registration};

#[derive(Debug, Clone, PartialEq)]
pub struct Diag {
    pub file: String,
    /// UTF-16 code-unit offset in `file`; 0 for component diagnostics.
    pub at: usize,
    pub code: &'static str,
    pub message: String,
    /// The `@inject` name, for diagnostics about a component's injects.
    pub inject: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Own,
    /// (index into `provider.imports`, index into that import's `Resolved.services`).
    Imported(usize, usize),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Arg {
    Service(usize),
    Awaited(usize),
    Promise(usize),
    /// A parameterless transient (see `is_inline`), emitted as `new Impl()`; the index is into `Resolved.services`.
    Inline(usize),
    /// A cached async dependency already resolved inside another `Awaited` arg's subtree; read from its value field.
    Covered(usize),
    Undefined,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Service {
    pub reg: Registration,
    pub getter: String,
    pub source: Source,
    pub args: Vec<Arg>,
    pub is_async: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub provider: Provider,
    pub services: Vec<Service>,
    /// Filled only for the `@Mount` provider; the `bool` marks an asynchronously resolved component.
    pub components: Vec<(Component, Vec<Arg>, bool)>,
}

/// Where a registration was declared: (provider index, registration index).
type Origin = (usize, usize);

enum State {
    Todo,
    Busy,
    Failed,
    Done(Resolved, Vec<Origin>),
}

/// Returns one `Resolved` per provider, in `facts.providers` order.
pub fn resolve(facts: &Facts) -> Result<Vec<Resolved>, Vec<Diag>> {
    if !facts.errors.is_empty() {
        return Err(facts
            .errors
            .iter()
            .map(|e| Diag { file: e.file.clone(), at: e.at, code: "ZDI11", message: e.message.clone(), inject: None })
            .collect());
    }
    let providers = &facts.providers;
    let mut cx = Cx {
        facts,
        by_class: providers.iter().enumerate().map(|(i, p)| (p.class.id.as_str(), i)).collect(),
        states: providers.iter().map(|_| State::Todo).collect(),
        stack: Vec::new(),
        diags: Vec::new(),
    };

    let mounts: Vec<usize> = (0..providers.len()).filter(|&i| providers[i].mount.is_some()).collect();
    if mounts.len() > 1 {
        let names = mounts.iter().map(|&i| providers[i].class.text.as_str()).collect::<Vec<_>>().join(", ");
        for &i in &mounts[1..] {
            let p = &providers[i];
            cx.error(&p.file, p.mount.as_ref().map_or(p.at, |m| m.at), "ZDI07", format!("@Mount is declared on more than one class: {names}"));
        }
    }

    for i in 0..providers.len() {
        cx.provider(i);
    }

    if let Some(&m) = mounts.first() {
        if let State::Done(r, _) = &mut cx.states[m] {
            r.components = components(facts, r, &mut cx.diags);
        }
    } else {
        for c in &facts.components {
            let file = c.class.module.as_deref().unwrap_or(&c.class.text);
            for prm in &c.injects {
                let message = format!("{} (injected as {} in {}) is not provided: no @Mount application", prm.ty.text, prm.name, c.class.text);
                cx.diags.push(Diag { file: file.to_string(), at: 0, code: "ZDI04", message, inject: Some(prm.name.clone()) });
            }
        }
    }

    if !cx.diags.is_empty() {
        return Err(cx.diags);
    }
    Ok(cx.states.into_iter().filter_map(|s| if let State::Done(r, _) = s { Some(r) } else { None }).collect())
}

struct Cx<'a> {
    facts: &'a Facts,
    by_class: HashMap<&'a str, usize>,
    states: Vec<State>,
    /// Providers being resolved, for import cycles.
    stack: Vec<usize>,
    diags: Vec<Diag>,
}

impl<'a> Cx<'a> {
    fn error(&mut self, file: &str, at: usize, code: &'static str, message: String) {
        self.diags.push(Diag { file: file.to_string(), at, code, message, inject: None });
    }

    /// Resolves provider `pi` on its own (self-sufficiency); true when it resolved cleanly.
    fn provider(&mut self, pi: usize) -> bool {
        match self.states[pi] {
            State::Done(..) => return true,
            State::Failed => return false,
            State::Busy => {
                let providers = &self.facts.providers;
                let pos = self.stack.iter().position(|&x| x == pi).unwrap_or(0);
                let path = self.stack[pos..].iter().chain([&pi]).map(|&i| providers[i].class.text.as_str()).collect::<Vec<_>>().join(" -> ");
                let p = &providers[pi];
                self.error(&p.file, p.at, "ZDI03", path);
                return false;
            }
            State::Todo => {}
        }
        self.states[pi] = State::Busy;
        self.stack.push(pi);
        let state = self.build(pi);
        self.stack.pop();
        let ok = state.is_some();
        self.states[pi] = state.map_or(State::Failed, |(r, o)| State::Done(r, o));
        ok
    }

    fn build(&mut self, pi: usize) -> Option<(Resolved, Vec<Origin>)> {
        let facts = self.facts;
        let p = &facts.providers[pi];

        let mut imports = Vec::with_capacity(p.imports.len());
        let mut failed = false;
        for t in &p.imports {
            match self.by_class.get(t.id.as_str()) {
                Some(&j) => {
                    failed |= !self.provider(j);
                    imports.push(j);
                }
                None => {
                    self.error(&p.file, p.at, "ZDI02", format!("{} (imported by {}) is not a @ServiceProvider", t.text, p.class.text));
                    failed = true;
                }
            }
        }
        if failed {
            return None;
        }

        let start = self.diags.len();
        let mut services = Vec::with_capacity(p.registrations.len());
        let mut origins = Vec::with_capacity(p.registrations.len());
        for (ri, reg) in p.registrations.iter().enumerate() {
            if reg.impl_.is_none() && reg.factory.is_none() {
                self.error(&p.file, reg.at, "ZDI06", format!("{} is registered without an implementation or factory", reg.service.text));
            }
            services.push(Service { reg: reg.clone(), getter: String::new(), source: Source::Own, args: Vec::new(), is_async: reg.is_async });
            origins.push((pi, ri));
        }
        let own = services.len();

        // Imported services (transitively), deduplicated by origin so a diamond import is not a duplicate.
        if !imports.is_empty() {
            let mut seen: HashMap<Origin, usize> = HashMap::new();
            for (ii, &j) in imports.iter().enumerate() {
                let State::Done(r, o) = &self.states[j] else { unreachable!() };
                let first = services.len();
                let remap: Vec<usize> = r
                    .services
                    .iter()
                    .zip(o)
                    .enumerate()
                    .map(|(si, (s, &origin))| {
                        *seen.entry(origin).or_insert_with(|| {
                            services.push(Service {
                                reg: s.reg.clone(),
                                getter: String::new(),
                                source: Source::Imported(ii, si),
                                args: s.args.clone(),
                                is_async: s.is_async,
                            });
                            origins.push(origin);
                            services.len() - 1
                        })
                    })
                    .collect();
                for s in &mut services[first..] {
                    for a in &mut s.args {
                        if let Arg::Service(i) | Arg::Awaited(i) | Arg::Promise(i) | Arg::Inline(i) | Arg::Covered(i) = a {
                            *i = remap[*i];
                        }
                    }
                }
            }
        }

        let mut dups: HashSet<(&str, Option<&str>)> = HashSet::with_capacity(services.len());
        for s in &services {
            if !dups.insert((s.reg.service.id.as_str(), s.reg.key.as_deref())) {
                let at = if s.source == Source::Own { s.reg.at } else { p.at };
                let key = s.reg.key.as_ref().map_or(String::new(), |k| format!(" \"{k}\""));
                self.error(&p.file, at, "ZDI01", format!("{}{key} is registered twice in provider {}", s.reg.service.text, p.class.text));
            }
        }
        drop(dups);
        if self.diags.len() > start {
            return None;
        }

        assign_getters(&mut services);

        let table = Table::new(&services);
        let mut all_args = Vec::with_capacity(own);
        for s in &services[..own] {
            let needer = needer(&s.reg);
            let mut args = Vec::with_capacity(s.reg.params.len());
            for prm in &s.reg.params {
                args.push(match table.find(prm) {
                    Found::One(i) => if prm.promise { Arg::Promise(i) } else { Arg::Service(i) },
                    Found::None if prm.optional => Arg::Undefined,
                    Found::None => {
                        let m = format!("{} (needed by {needer} in provider {}) is not registered or imported", prm.ty.text, p.class.text);
                        self.error(&p.file, s.reg.at, "ZDI02", m);
                        Arg::Undefined
                    }
                    Found::Many(c) => {
                        let m = format!("{} (needed by {needer} in provider {}) is ambiguous: {}", prm.ty.text, p.class.text, table.names(&c));
                        self.error(&p.file, s.reg.at, "ZDI05", m);
                        Arg::Undefined
                    }
                });
            }
            all_args.push(args);
        }
        drop(table);
        if self.diags.len() > start {
            return None;
        }
        for (s, args) in services.iter_mut().zip(all_args) {
            s.args = args;
        }

        let mut color = vec![White; own];
        let mut path = Vec::new();
        for i in 0..own {
            if color[i] == White {
                if let Err(cycle) = visit(i, &mut services, &mut color, &mut path) {
                    let names = cycle.iter().map(|&k| needer(&services[k].reg)).collect::<Vec<_>>().join(" -> ");
                    self.error(&p.file, services[cycle[0]].reg.at, "ZDI03", names);
                    return None;
                }
            }
        }

        let sets = Sets::new(&services);
        for i in 0..own {
            services[i].args = classify(&services, &sets, &services[i].args);
        }
        if self.diags.len() > start {
            return None;
        }

        Some((Resolved { provider: p.clone(), services, components: Vec::new() }, origins))
    }
}

/// Resolves the injects of every `@inject` component against the mount provider.
fn components(facts: &Facts, r: &Resolved, diags: &mut Vec<Diag>) -> Vec<(Component, Vec<Arg>, bool)> {
    let table = Table::new(&r.services);
    let sets = Sets::new(&r.services);
    let app = &r.provider.class.text;
    let mut out = Vec::with_capacity(facts.components.len());
    for c in &facts.components {
        let mut args = Vec::with_capacity(c.injects.len());
        for prm in &c.injects {
            let (code, message) = match table.find(prm) {
                Found::One(i) => {
                    args.push(if prm.promise { Arg::Promise(i) } else { Arg::Service(i) });
                    continue;
                }
                Found::None if prm.optional => {
                    args.push(Arg::Undefined);
                    continue;
                }
                Found::None => ("ZDI04", format!("{} (injected as {} in {}) is not provided by {app}", prm.ty.text, prm.name, c.class.text)),
                Found::Many(m) => ("ZDI05", format!("{} (injected as {} in {}) is ambiguous: {}", prm.ty.text, prm.name, c.class.text, table.names(&m))),
            };
            let file = c.class.module.as_deref().unwrap_or(&c.class.text).to_string();
            diags.push(Diag { file, at: 0, code, message, inject: Some(prm.name.clone()) });
            args.push(Arg::Undefined);
        }
        let args = classify(&r.services, &sets, &args);
        let is_async = args.iter().any(|a| matches!(a, Arg::Awaited(_)));
        out.push((c.clone(), args, is_async));
    }
    out
}

/// A transient with an implementation, no factory and no parameters: emitted as `new Impl()`, with no member.
pub fn is_inline(s: &Service) -> bool {
    let r = &s.reg;
    r.lifetime == Lifetime::Transient && r.impl_.is_some() && r.factory.is_none() && r.params.is_empty()
}

/// The final form of resolved args: `T` params become `Awaited` (async service; `Covered` when a cached one is
/// already resolved inside a sibling's subtree), `Inline` (parameterless transient) or stay `Service`.
fn classify(services: &[Service], sets: &Sets, args: &[Arg]) -> Vec<Arg> {
    args.iter()
        .map(|a| {
            let &Arg::Service(j) = a else { return a.clone() };
            let s = &services[j];
            if s.is_async {
                let covered = s.reg.lifetime != Lifetime::Transient
                    && args.iter().any(|b| matches!(b, &Arg::Service(k) if k != j && services[k].is_async && sets.has(k, j)));
                if covered { Arg::Covered(j) } else { Arg::Awaited(j) }
            } else if is_inline(s) {
                Arg::Inline(j)
            } else {
                a.clone()
            }
        })
        .collect()
}

/// Per service, a bitset of the cached async services in its awaited subtree (itself included).
struct Sets {
    words: usize,
    bits: Vec<u64>,
}

impl Sets {
    /// Edges are `Service`/`Awaited` args to async services, so imported (classified) and own (raw) args both work.
    fn new(services: &[Service]) -> Self {
        let words = services.len().div_ceil(64);
        let mut sets = Sets { words, bits: vec![0; services.len() * words] };
        let mut done = vec![false; services.len()];
        for i in 0..services.len() {
            sets.fill(i, services, &mut done);
        }
        sets
    }

    fn fill(&mut self, i: usize, services: &[Service], done: &mut [bool]) {
        if done[i] {
            return;
        }
        done[i] = true;
        for a in &services[i].args {
            if let &(Arg::Service(j) | Arg::Awaited(j)) = a {
                if services[j].is_async {
                    self.fill(j, services, done);
                    for w in 0..self.words {
                        self.bits[i * self.words + w] |= self.bits[j * self.words + w];
                    }
                }
            }
        }
        if services[i].is_async && services[i].reg.lifetime != Lifetime::Transient {
            self.bits[i * self.words + i / 64] |= 1 << (i % 64);
        }
        // A singleton may have been resolved in another scope: its scoped dependencies are not this scope's.
        if services[i].reg.lifetime == Lifetime::Singleton {
            for (k, s) in services.iter().enumerate() {
                if s.reg.lifetime == Lifetime::Scoped {
                    self.bits[i * self.words + k / 64] &= !(1 << (k % 64));
                }
            }
        }
    }

    /// Whether `j` is a cached async service in `k`'s subtree.
    fn has(&self, k: usize, j: usize) -> bool {
        self.bits[k * self.words + j / 64] >> (j % 64) & 1 == 1
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Color {
    White,
    Grey,
    Black,
}
use Color::*;

/// DFS over own services; computes `is_async` in post-order, or returns the cycle path.
fn visit(i: usize, services: &mut [Service], color: &mut [Color], path: &mut Vec<usize>) -> Result<(), Vec<usize>> {
    color[i] = Grey;
    path.push(i);
    for k in 0..services[i].args.len() {
        let j = match services[i].args[k] {
            Arg::Service(j) | Arg::Promise(j) => j,
            _ => continue,
        };
        if j >= color.len() {
            continue;
        }
        match color[j] {
            Grey => {
                let pos = path.iter().position(|&x| x == j).unwrap();
                let mut cycle = path[pos..].to_vec();
                cycle.push(j);
                return Err(cycle);
            }
            White => visit(j, services, color, path)?,
            Black => {}
        }
    }
    path.pop();
    color[i] = Black;
    let s = &services[i];
    let is_async = s.reg.is_async || s.args.iter().any(|a| matches!(a, Arg::Service(j) if services[*j].is_async));
    services[i].is_async = is_async;
    Ok(())
}

fn needer(r: &Registration) -> &str {
    match (&r.impl_, &r.key) {
        (Some(t), _) => &t.text,
        (None, Some(k)) => k,
        (None, None) => &r.service.text,
    }
}

/// Members of the generated provider class that a getter must not shadow.
const RESERVED: [&str; 9] =
    ["root", "createScope", "dispose", "disposeAsync", "createComponent", "constructor", "shared", "disposed", "disposeScoped"];

/// The key, else the type text camelCased without a leading `I` + uppercase letter; collisions get `1`, `2`, ...
fn assign_getters(services: &mut [Service]) {
    let mut used: HashMap<String, u32> = HashMap::with_capacity(services.len() + RESERVED.len());
    used.extend(RESERVED.iter().map(|n| (n.to_string(), 0)));
    for s in services.iter_mut() {
        let base = match &s.reg.key {
            Some(k) => k.clone(),
            None => camel(&s.reg.service.text),
        };
        let name = match used.get(&base).copied() {
            None => base,
            Some(mut n) => loop {
                n += 1;
                let name = format!("{base}{n}");
                if !used.contains_key(&name) {
                    used.insert(base, n);
                    break name;
                }
            },
        };
        used.insert(name.clone(), 0);
        s.getter = name;
    }
}

fn camel(text: &str) -> String {
    let mut chars = text.chars().filter(|c| c.is_alphanumeric() || *c == '_' || *c == '$').peekable();
    let mut out = String::with_capacity(text.len());
    let first = chars.next();
    let first = match (first, chars.peek()) {
        (Some('I'), Some(c)) if c.is_uppercase() => chars.next(),
        _ => first,
    };
    if let Some(c) = first {
        out.extend(c.to_lowercase());
    }
    out.extend(chars);
    out
}

enum Found {
    One(usize),
    None,
    Many(Vec<usize>),
}

struct Table<'a> {
    services: &'a [Service],
    by_key: HashMap<&'a str, Vec<usize>>,
    by_type: HashMap<&'a str, Vec<usize>>,
}

impl<'a> Table<'a> {
    fn new(services: &'a [Service]) -> Self {
        let mut by_key: HashMap<&str, Vec<usize>> = HashMap::new();
        let mut by_type: HashMap<&str, Vec<usize>> = HashMap::with_capacity(services.len());
        for (i, s) in services.iter().enumerate() {
            if let Some(k) = &s.reg.key {
                by_key.entry(k).or_default().push(i);
            }
            by_type.entry(&s.reg.service.id).or_default().push(i);
        }
        Table { services, by_key, by_type }
    }

    /// Key equal to the parameter name, then the type (an unkeyed registration wins over keyed ones).
    fn find(&self, p: &Param) -> Found {
        if let Some(v) = self.by_key.get(p.name.as_str()) {
            return if v.len() == 1 { Found::One(v[0]) } else { Found::Many(v.clone()) };
        }
        let Some(v) = self.by_type.get(p.ty.id.as_str()) else { return Found::None };
        if v.len() == 1 {
            return Found::One(v[0]);
        }
        let mut unkeyed = v.iter().filter(|&&i| self.services[i].reg.key.is_none());
        match (unkeyed.next(), unkeyed.next()) {
            (Some(&i), None) => Found::One(i),
            _ => Found::Many(v.clone()),
        }
    }

    fn names(&self, c: &[usize]) -> String {
        c.iter().map(|&i| self.services[i].getter.as_str()).collect::<Vec<_>>().join(", ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::di::model::{Component, FactError, Facts, Factory, Lifetime, Mount, Param, Provider, Registration, TypeRef};

    fn ty(name: &str) -> TypeRef {
        TypeRef { id: format!("m.ts#{name}"), text: name.into(), module: Some("m".into()), export: Some(name.into()) }
    }

    fn param(name: &str, t: &str) -> Param {
        Param { name: name.into(), optional: false, promise: false, ty: ty(t) }
    }

    fn promise(name: &str, t: &str) -> Param {
        Param { promise: true, ..param(name, t) }
    }

    fn reg(lifetime: Lifetime, service: &str, impl_: &str, params: Vec<Param>) -> Registration {
        Registration {
            lifetime,
            service: ty(service),
            impl_: Some(ty(impl_)),
            key: None,
            factory: None,
            is_async: false,
            params,
            dispose: None,
            at: 7,
        }
    }

    fn single(service: &str, impl_: &str, params: Vec<Param>) -> Registration {
        reg(Lifetime::Singleton, service, impl_, params)
    }

    fn keyed(key: &str, r: Registration) -> Registration {
        Registration { key: Some(key.into()), ..r }
    }

    fn async_factory(service: &str) -> Registration {
        Registration {
            impl_: None,
            factory: Some(Factory { owner: ty("Factories"), member: "load".into() }),
            is_async: true,
            ..single(service, service, vec![])
        }
    }

    fn provider(name: &str, imports: &[&str], registrations: Vec<Registration>) -> Provider {
        Provider {
            class: ty(name),
            file: format!("{name}.ts"),
            at: 3,
            imports: imports.iter().map(|i| ty(i)).collect(),
            registrations,
            mount: None,
        }
    }

    fn mounted(p: Provider) -> Provider {
        Provider { mount: Some(Mount { component: ty("App"), target: "app".into(), at: 1 }), ..p }
    }

    fn component(name: &str, injects: Vec<Param>) -> Component {
        Component {
            class: TypeRef {
                id: format!("{name}.tszor.ts#default"),
                text: name.into(),
                module: Some(format!("{name}.tszor")),
                export: Some("default".into()),
            },
            injects,
        }
    }

    fn facts(providers: Vec<Provider>) -> Facts {
        Facts { providers, ..Facts::default() }
    }

    fn ok(f: &Facts) -> Vec<Resolved> {
        resolve(f).unwrap_or_else(|d| panic!("unexpected diagnostics: {d:#?}"))
    }

    fn err(f: &Facts) -> Vec<Diag> {
        match resolve(f) {
            Ok(_) => panic!("expected diagnostics"),
            Err(d) => d,
        }
    }

    fn codes(d: &[Diag]) -> Vec<&'static str> {
        d.iter().map(|d| d.code).collect()
    }

    fn getters(r: &Resolved) -> Vec<&str> {
        r.services.iter().map(|s| s.getter.as_str()).collect()
    }

    #[test]
    fn resolves_by_key_then_type() {
        let f = facts(vec![provider(
            "P",
            &[],
            vec![
                single("ILogger", "ConsoleLogger", vec![]),
                keyed("audit", single("ILogger", "AuditLogger", vec![])),
                single("IDatabase", "Database", vec![param("log", "ILogger"), param("audit", "ILogger")]),
            ],
        )]);
        let r = ok(&f);
        assert_eq!(getters(&r[0]), ["logger", "audit", "database"]);
        assert_eq!(r[0].services[2].args, [Arg::Service(0), Arg::Service(1)]);
        assert_eq!(r[0].services[2].source, Source::Own);
    }

    #[test]
    fn optional_param_gets_undefined() {
        let optional = Param { optional: true, ..param("log", "ILogger") };
        let f = facts(vec![provider("P", &[], vec![single("IDatabase", "Database", vec![optional.clone()])])]);
        assert_eq!(ok(&f)[0].services[0].args, [Arg::Undefined]);

        let f = facts(vec![provider(
            "P",
            &[],
            vec![single("IDatabase", "Database", vec![optional]), single("ILogger", "ConsoleLogger", vec![])],
        )]);
        assert_eq!(ok(&f)[0].services[0].args, [Arg::Service(1)]);
    }

    #[test]
    fn zdi01_duplicate() {
        let f = facts(vec![provider(
            "P",
            &[],
            vec![single("ILogger", "ConsoleLogger", vec![]), single("ILogger", "FileLogger", vec![])],
        )]);
        let d = err(&f);
        assert_eq!(codes(&d), ["ZDI01"]);
        assert_eq!((d[0].file.as_str(), d[0].at), ("P.ts", 7));
        assert_eq!(d[0].message, "ILogger is registered twice in provider P");

        // A keyed registration of the same type is not a duplicate.
        let f = facts(vec![provider(
            "P",
            &[],
            vec![single("ILogger", "ConsoleLogger", vec![]), keyed("audit", single("ILogger", "FileLogger", vec![]))],
        )]);
        ok(&f);

        let f = facts(vec![
            provider("A", &["B", "C"], vec![]),
            provider("B", &[], vec![single("ILogger", "ConsoleLogger", vec![])]),
            provider("C", &[], vec![single("ILogger", "FileLogger", vec![])]),
        ]);
        let d = err(&f);
        assert_eq!(codes(&d), ["ZDI01"]);
        assert_eq!((d[0].file.as_str(), d[0].at), ("A.ts", 3));
        assert_eq!(d[0].message, "ILogger is registered twice in provider A");
    }

    #[test]
    fn diamond_import_is_not_a_duplicate() {
        let f = facts(vec![
            provider("A", &["B", "C"], vec![]),
            provider("B", &["D"], vec![]),
            provider("C", &["D"], vec![]),
            provider("D", &[], vec![single("ILogger", "ConsoleLogger", vec![])]),
        ]);
        let r = ok(&f);
        assert_eq!(r[0].services.len(), 1);
        assert_eq!(r[0].services[0].source, Source::Imported(0, 0));
    }

    #[test]
    fn zdi02_unresolved_names_needer_and_provider() {
        let f = facts(vec![provider("DataServices", &[], vec![single("IDatabase", "Database", vec![param("log", "ILogger")])])]);
        let d = err(&f);
        assert_eq!(codes(&d), ["ZDI02"]);
        assert_eq!((d[0].file.as_str(), d[0].at, d[0].inject.as_deref()), ("DataServices.ts", 7, None));
        assert_eq!(d[0].message, "ILogger (needed by Database in provider DataServices) is not registered or imported");
    }

    #[test]
    fn zdi02_imported_provider_must_be_self_sufficient() {
        let f = facts(vec![
            provider("Application", &["DataServices"], vec![single("ILogger", "ConsoleLogger", vec![])]),
            provider("DataServices", &[], vec![single("IDatabase", "Database", vec![param("log", "ILogger")])]),
        ]);
        let d = err(&f);
        assert_eq!(codes(&d), ["ZDI02"]);
        assert_eq!(d[0].file, "DataServices.ts");
        assert_eq!(d[0].message, "ILogger (needed by Database in provider DataServices) is not registered or imported");
    }

    #[test]
    fn analyzer_errors_are_zdi11() {
        let f = Facts {
            errors: vec![FactError { file: "s.ts".into(), at: 4, message: "Hidden must be exported to be injected".into() }],
            ..facts(vec![provider("P", &[], vec![])])
        };
        assert_eq!(
            err(&f),
            [Diag { file: "s.ts".into(), at: 4, code: "ZDI11", message: "Hidden must be exported to be injected".into(), inject: None }]
        );
    }

    #[test]
    fn imported_services_are_remapped() {
        let f = facts(vec![
            provider("App", &["Data"], vec![single("AuthService", "AuthService", vec![param("db", "IDatabase")])]),
            provider(
                "Data",
                &[],
                vec![
                    single("IDatabase", "Database", vec![param("log", "ILogger")]),
                    reg(Lifetime::Transient, "ILogger", "ConsoleLogger", vec![param("x", "X")]),
                    single("X", "X", vec![]),
                ],
            ),
        ]);
        let r = ok(&f);
        assert_eq!(getters(&r[0]), ["authService", "database", "logger", "x"]);
        let s = &r[0].services;
        assert_eq!(s[0].args, [Arg::Service(1)]);
        assert_eq!(s[1].source, Source::Imported(0, 0));
        assert_eq!(s[1].args, [Arg::Service(2)]);
        assert_eq!(s[2].args, [Arg::Service(3)]);
        assert_eq!(r[1].services.len(), 3);
    }

    #[test]
    fn zdi03_cycle() {
        let f = facts(vec![provider(
            "P",
            &[],
            vec![single("A", "A", vec![param("b", "B")]), single("B", "B", vec![param("a", "A")])],
        )]);
        let d = err(&f);
        assert_eq!(codes(&d), ["ZDI03"]);
        assert_eq!(d[0].message, "A -> B -> A");
    }

    #[test]
    fn zdi04_inject_not_provided() {
        let f = Facts {
            components: vec![component("Counter", vec![param("db", "IDatabase")])],
            ..facts(vec![mounted(provider("Application", &[], vec![]))])
        };
        let d = err(&f);
        assert_eq!(codes(&d), ["ZDI04"]);
        assert_eq!((d[0].file.as_str(), d[0].at, d[0].inject.as_deref()), ("Counter.tszor", 0, Some("db")));
        assert_eq!(d[0].message, "IDatabase (injected as db in Counter) is not provided by Application");
    }

    #[test]
    fn zdi04_inject_without_mount() {
        let f = Facts {
            components: vec![component("Counter", vec![param("db", "IDatabase")])],
            ..facts(vec![provider("Application", &[], vec![single("IDatabase", "Database", vec![])])])
        };
        let d = err(&f);
        assert_eq!(codes(&d), ["ZDI04"]);
        assert_eq!((d[0].file.as_str(), d[0].at, d[0].inject.as_deref()), ("Counter.tszor", 0, Some("db")));
        assert_eq!(d[0].message, "IDatabase (injected as db in Counter) is not provided: no @Mount application");
    }

    #[test]
    fn zdi05_ambiguous() {
        let f = facts(vec![provider(
            "P",
            &[],
            vec![
                keyed("a", single("ILogger", "ConsoleLogger", vec![])),
                keyed("b", single("ILogger", "FileLogger", vec![])),
                single("IDatabase", "Database", vec![param("log", "ILogger")]),
            ],
        )]);
        let d = err(&f);
        assert_eq!(codes(&d), ["ZDI05"]);
        assert_eq!(d[0].message, "ILogger (needed by Database in provider P) is ambiguous: a, b");
    }

    #[test]
    fn zdi06_interface_without_impl() {
        let f = facts(vec![provider("P", &[], vec![Registration { impl_: None, ..single("ILogger", "ILogger", vec![]) }])]);
        let d = err(&f);
        assert_eq!(codes(&d), ["ZDI06"]);
        assert_eq!(d[0].message, "ILogger is registered without an implementation or factory");
    }

    #[test]
    fn zdi07_two_mounts() {
        let f = facts(vec![mounted(provider("Application", &[], vec![])), mounted(provider("Other", &[], vec![]))]);
        let d = err(&f);
        assert_eq!(codes(&d), ["ZDI07"]);
        assert_eq!((d[0].file.as_str(), d[0].at), ("Other.ts", 1));
        assert_eq!(d[0].message, "@Mount is declared on more than one class: Application, Other");
    }

    #[test]
    fn component_with_async_inject_is_async() {
        let f = Facts {
            components: vec![
                component("Counter", vec![param("db", "IDatabase")]),
                component("Lazy", vec![promise("db", "IDatabase")]),
            ],
            ..facts(vec![mounted(provider("Application", &[], vec![async_factory("IDatabase")]))])
        };
        let r = ok(&f);
        let c = &r[0].components;
        assert_eq!((c[0].0.class.text.as_str(), &c[0].1, c[0].2), ("Counter", &vec![Arg::Awaited(0)], true));
        assert_eq!((c[1].0.class.text.as_str(), &c[1].1, c[1].2), ("Lazy", &vec![Arg::Promise(0)], false));
    }

    #[test]
    fn async_propagates_up() {
        let f = facts(vec![provider(
            "P",
            &[],
            vec![
                single("Controller", "Controller", vec![param("auth", "AuthService")]),
                single("AuthService", "AuthService", vec![param("db", "IDatabase")]),
                async_factory("IDatabase"),
                single("Report", "Report", vec![promise("db", "IDatabase")]),
            ],
        )]);
        let r = ok(&f);
        let s = &r[0].services;
        assert_eq!(s.iter().map(|s| s.is_async).collect::<Vec<_>>(), [true, true, true, false]);
        assert_eq!(getters(&r[0]), ["controller", "authService", "database", "report"]);
        assert_eq!(s[0].args, [Arg::Awaited(1)]);
        assert_eq!(s[1].args, [Arg::Awaited(2)]);
        assert_eq!(s[3].args, [Arg::Promise(2)]);
    }

    #[test]
    fn parameterless_transient_is_inline() {
        let f = facts(vec![provider(
            "P",
            &[],
            vec![
                reg(Lifetime::Transient, "Clock", "SystemClock", vec![]),
                single("AuthService", "AuthService", vec![param("clock", "Clock")]),
            ],
        )]);
        let s = &ok(&f)[0].services;
        assert_eq!(s[1].args, [Arg::Inline(0)]);
        assert!(is_inline(&s[0]) && !is_inline(&s[1]));
    }

    #[test]
    fn reserved_member_names_are_not_used_as_getters() {
        let f = facts(vec![provider(
            "P",
            &[],
            vec![
                keyed("root", single("Root", "Root", vec![])),
                keyed("dispose", single("D", "D", vec![])),
                keyed("shared", single("S", "S", vec![])),
                keyed("disposed", single("E", "E", vec![])),
                keyed("disposeScoped", single("F", "F", vec![])),
            ],
        )]);
        assert_eq!(getters(&ok(&f)[0]), ["root1", "dispose1", "shared1", "disposed1", "disposeScoped1"]);
    }

    fn scoped(service: &str, params: Vec<Param>) -> Registration {
        reg(Lifetime::Scoped, service, service, params)
    }

    fn transient(service: &str, params: Vec<Param>) -> Registration {
        reg(Lifetime::Transient, service, service, params)
    }

    #[test]
    fn captive_dependencies_are_allowed() {
        let f = facts(vec![provider(
            "P",
            &[],
            vec![
                single("IDatabase", "Database", vec![param("uow", "UnitOfWork")]),
                single("Report", "Report", vec![promise("clock", "Clock")]),
                transient("Clock", vec![param("uow", "UnitOfWork")]),
                scoped("UnitOfWork", vec![]),
            ],
        )]);
        ok(&f);
        let f = facts(vec![
            provider("App", &["Data"], vec![single("Auth", "Auth", vec![param("clock", "Clock")])]),
            provider("Data", &[], vec![transient("Clock", vec![param("session", "Session")]), scoped("Session", vec![])]),
        ]);
        ok(&f);
    }

    #[test]
    fn scoped_behind_a_singleton_is_not_covered() {
        // The singleton may have been resolved in another scope, so this scope's tenant is awaited again.
        let tenant = Registration { lifetime: Lifetime::Scoped, ..async_factory("Tenant") };
        let f = facts(vec![provider(
            "P",
            &[],
            vec![
                scoped("AuthService", vec![param("db", "IDatabase"), param("tenant", "Tenant")]),
                single("IDatabase", "Database", vec![param("tenant", "Tenant")]),
                tenant,
            ],
        )]);
        let s = &ok(&f)[0].services;
        assert_eq!(s[0].args, [Arg::Awaited(1), Arg::Awaited(2)]);
    }

    #[test]
    fn scoped_behind_a_scoped_is_covered() {
        let tenant = Registration { lifetime: Lifetime::Scoped, ..async_factory("Tenant") };
        let f = facts(vec![provider(
            "P",
            &[],
            vec![
                scoped("AuthService", vec![param("db", "IDatabase"), param("tenant", "Tenant")]),
                scoped("IDatabase", vec![param("tenant", "Tenant")]),
                tenant,
            ],
        )]);
        assert_eq!(ok(&f)[0].services[0].args, [Arg::Awaited(1), Arg::Covered(2)]);
    }

    fn covered_services(some_int: Registration) -> Vec<Registration> {
        vec![
            single("AuthService", "AuthService", vec![param("db", "IDatabase"), param("someInt", "SomeInt")]),
            single("IDatabase", "Database", vec![param("someInt", "SomeInt")]),
            some_int,
        ]
    }

    #[test]
    fn cached_dependency_inside_an_awaited_subtree_is_covered() {
        let f = facts(vec![provider("P", &[], covered_services(async_factory("SomeInt")))]);
        let s = &ok(&f)[0].services;
        assert_eq!(s[0].args, [Arg::Awaited(1), Arg::Covered(2)]);
        assert_eq!(s[1].args, [Arg::Awaited(2)]);
    }

    #[test]
    fn transient_dependency_is_always_awaited() {
        let some_int = Registration { lifetime: Lifetime::Transient, ..async_factory("SomeInt") };
        let f = facts(vec![provider("P", &[], covered_services(some_int))]);
        assert_eq!(ok(&f)[0].services[0].args, [Arg::Awaited(1), Arg::Awaited(2)]);
    }

    #[test]
    fn component_dependency_inside_an_awaited_subtree_is_covered() {
        let f = Facts {
            components: vec![component("Counter", vec![param("db", "IDatabase"), param("someInt", "SomeInt")])],
            ..facts(vec![mounted(provider(
                "Application",
                &[],
                vec![single("IDatabase", "Database", vec![param("someInt", "SomeInt")]), async_factory("SomeInt")],
            ))])
        };
        let c = &ok(&f)[0].components[0];
        assert_eq!((&c.1, c.2), (&vec![Arg::Awaited(0), Arg::Covered(1)], true));
    }

    #[test]
    fn zdi03_provider_import_cycle() {
        let f = facts(vec![provider("A", &["B"], vec![]), provider("B", &["A"], vec![])]);
        let d = err(&f);
        assert_eq!(codes(&d), ["ZDI03"]);
        assert_eq!((d[0].file.as_str(), d[0].at), ("A.ts", 3));
        assert_eq!(d[0].message, "A -> B -> A");
    }

    #[test]
    fn async_propagates_from_an_imported_service() {
        let f = facts(vec![
            provider("App", &["Data"], vec![single("AuthService", "AuthService", vec![param("db", "IDatabase")])]),
            provider("Data", &[], vec![async_factory("IDatabase")]),
        ]);
        let s = &ok(&f)[0].services;
        assert_eq!(s.iter().map(|s| s.is_async).collect::<Vec<_>>(), [true, true]);
        assert_eq!(s[0].args, [Arg::Awaited(1)]);
    }

    #[test]
    fn imported_scoped_service_feeds_an_async_dependency() {
        let f = facts(vec![
            provider(
                "App",
                &["Data"],
                vec![reg(Lifetime::Scoped, "Auth", "Auth", vec![param("session", "Session"), param("config", "Config")])],
            ),
            provider(
                "Data",
                &[],
                vec![reg(Lifetime::Scoped, "Session", "Session", vec![param("config", "Config")]), async_factory("Config")],
            ),
        ]);
        let s = &ok(&f)[0].services;
        assert_eq!(getters(&ok(&f)[0]), ["auth", "session", "config"]);
        assert_eq!(s.iter().map(|s| s.is_async).collect::<Vec<_>>(), [true, true, true]);
        assert_eq!(s[1].source, Source::Imported(0, 0));
        assert_eq!(s[1].args, [Arg::Awaited(2)]);
        assert_eq!(s[0].args, [Arg::Awaited(1), Arg::Covered(2)]);
    }

    #[test]
    fn getter_collisions_get_suffixes() {
        let f = facts(vec![provider(
            "P",
            &[],
            vec![single("IDatabase", "Database", vec![]), single("Database", "Database", vec![]), single("IO", "IO", vec![])],
        )]);
        assert_eq!(getters(&ok(&f)[0]), ["database", "database1", "o"]);
    }
}
