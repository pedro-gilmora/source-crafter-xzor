//! Resolves the dependency graph from the analyzer facts.

use std::collections::{HashMap, HashSet};

use super::model::{Component, Endpoint, Facts, Lifetime, Param, ParamKind, Provider, Registration, Server, Verb};

#[derive(Debug, Clone, PartialEq)]
pub struct Diag {
    pub file: String,
    /// UTF-16 code-unit offset in `file`; 0 for component diagnostics.
    pub at: usize,
    pub code: &'static str,
    pub message: String,
    /// The `@inject` name, for diagnostics about a component's injects.
    pub inject: Option<String>,
    /// (file, UTF-16 offset) of the constructor or factory parameter the diagnostic is about; overrides `file`/`at`.
    pub param_at: Option<(String, usize)>,
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
    /// Filled only for the `@Run` provider; the `bool` marks an asynchronously resolved component.
    pub components: Vec<(Component, Vec<Arg>, bool)>,
    /// Set on the `@Run` server application's provider.
    pub server: Option<Server>,
    /// Filled only for the server application: each `@Endpoints` class with its constructor args.
    pub endpoints: Vec<(Endpoint, Vec<Arg>)>,
    /// For a server app with views: the services the views reach (`@inject`, then constructor args), ascending.
    pub browser: Vec<usize>,
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
            .map(|e| Diag { file: e.file.clone(), at: e.at, code: "ZDI11", message: e.message.clone(), inject: None, param_at: None })
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

    let server_of = |p: &Provider| facts.servers.iter().find(|s| s.class.id == p.class.id);
    let mounts: Vec<usize> = (0..providers.len()).filter(|&i| providers[i].mount.is_some() || server_of(&providers[i]).is_some()).collect();
    if mounts.len() > 1 {
        let names = mounts.iter().map(|&i| providers[i].class.text.as_str()).collect::<Vec<_>>().join(", ");
        for &i in &mounts[1..] {
            let p = &providers[i];
            let at = p.mount.as_ref().map(|m| m.at).or(server_of(p).map(|s| s.at)).unwrap_or(p.at);
            cx.error(&p.file, at, "ZDI07", format!("@Run is declared on more than one class: {names}"));
        }
    }
    check_endpoints(facts, &mut cx.diags);

    for i in 0..providers.len() {
        cx.provider(i);
    }

    if let Some(&m) = mounts.first() {
        if let State::Done(r, o) = &mut cx.states[m] {
            r.components = components(facts, r, o, &mut cx.diags);
            if let Some(s) = server_of(&r.provider) {
                r.server = Some(s.clone());
                r.endpoints = endpoints(facts, r, o, &mut cx.diags);
                // The server keeps every registration; the browser gets what the views reach.
                if s.root.is_some() {
                    r.browser = reached(&r.services, r.components.iter().flat_map(|(_, args, _)| args));
                }
            }
        }
    } else {
        for c in &facts.components {
            let file = c.class.module.as_deref().unwrap_or(&c.class.text);
            for prm in &c.injects {
                let message = format!("{} (injected as {} in {}) is not provided: no @Run application", prm.ty.text, prm.name, c.class.text);
                cx.diags.push(Diag { file: file.to_string(), at: 0, code: "ZDI04", message, inject: Some(prm.name.clone()), param_at: None });
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
        self.diags.push(Diag { file: file.to_string(), at, code, message, inject: None, param_at: None });
    }

    fn param_error(&mut self, file: &str, at: usize, code: &'static str, message: String, prm: &Param) {
        let param_at = Some((prm.file.clone(), prm.at));
        self.diags.push(Diag { file: file.to_string(), at, code, message, inject: None, param_at });
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
                    Found::One(i) if mismatched(facts, prm, &services[i], origins[i]) => {
                        self.param_error(&p.file, s.reg.at, "ZDI12", zdi12(prm, &services[i]), prm);
                        Arg::Undefined
                    }
                    Found::One(i) => if prm.promise { Arg::Promise(i) } else { Arg::Service(i) },
                    Found::None if prm.optional => Arg::Undefined,
                    Found::None => {
                        let m = format!("{} (needed by {needer} in provider {}) is not registered or imported", prm.ty.text, p.class.text);
                        self.param_error(&p.file, s.reg.at, "ZDI02", m, prm);
                        Arg::Undefined
                    }
                    Found::Many(c) => {
                        let m = format!("{} (needed by {needer} in provider {}) is ambiguous: {}", prm.ty.text, p.class.text, table.names(&c));
                        self.param_error(&p.file, s.reg.at, "ZDI05", m, prm);
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

        Some((Resolved { provider: p.clone(), services, components: Vec::new(), server: None, endpoints: Vec::new(), browser: Vec::new() }, origins))
    }
}

/// Resolves the injects of every `@inject` component against the mount provider.
fn components(facts: &Facts, r: &Resolved, origins: &[Origin], diags: &mut Vec<Diag>) -> Vec<(Component, Vec<Arg>, bool)> {
    let table = Table::new(&r.services);
    let sets = Sets::new(&r.services);
    let app = &r.provider.class.text;
    let mut out = Vec::with_capacity(facts.components.len());
    for c in &facts.components {
        let mut args = Vec::with_capacity(c.injects.len());
        for prm in &c.injects {
            let (code, message) = match table.find(prm) {
                Found::One(i) if mismatched(facts, prm, &r.services[i], origins[i]) => ("ZDI12", zdi12(prm, &r.services[i])),
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
            diags.push(Diag { file, at: 0, code, message, inject: Some(prm.name.clone()), param_at: None });
            args.push(Arg::Undefined);
        }
        let args = classify(&r.services, &sets, &args);
        let is_async = args.iter().any(|a| matches!(a, Arg::Awaited(_)));
        out.push((c.clone(), args, is_async));
    }
    out
}

/// Resolves each `@Endpoints` class's constructor against the server application's registrations.
fn endpoints(facts: &Facts, r: &Resolved, origins: &[Origin], diags: &mut Vec<Diag>) -> Vec<(Endpoint, Vec<Arg>)> {
    let table = Table::new(&r.services);
    let sets = Sets::new(&r.services);
    let app = &r.provider.class.text;
    let mut out = Vec::with_capacity(facts.endpoints.len());
    for e in &facts.endpoints {
        let mut args = Vec::with_capacity(e.ctor.len());
        for prm in &e.ctor {
            let needer = &e.class.text;
            let (code, message) = match table.find(prm) {
                Found::One(i) if mismatched(facts, prm, &r.services[i], origins[i]) => ("ZDI12", zdi12(prm, &r.services[i])),
                Found::One(i) => {
                    args.push(if prm.promise { Arg::Promise(i) } else { Arg::Service(i) });
                    continue;
                }
                Found::None if prm.optional => {
                    args.push(Arg::Undefined);
                    continue;
                }
                Found::None => ("ZDI02", format!("{} (needed by {needer} in provider {app}) is not registered or imported", prm.ty.text)),
                Found::Many(c) => ("ZDI05", format!("{} (needed by {needer} in provider {app}) is ambiguous: {}", prm.ty.text, table.names(&c))),
            };
            diags.push(Diag { file: e.file.clone(), at: e.at, code, message, inject: None, param_at: Some((prm.file.clone(), prm.at)) });
            args.push(Arg::Undefined);
        }
        out.push((e.clone(), classify(&r.services, &sets, &args)));
    }
    out
}

/// The service index an arg reads, if any.
pub fn arg_service(a: &Arg) -> Option<usize> {
    match *a {
        Arg::Service(j) | Arg::Awaited(j) | Arg::Promise(j) | Arg::Inline(j) | Arg::Covered(j) => Some(j),
        Arg::Undefined => None,
    }
}

/// The services `roots` read, directly or through constructor args, ascending.
fn reached<'a>(services: &[Service], roots: impl Iterator<Item = &'a Arg>) -> Vec<usize> {
    let mut seen = vec![false; services.len()];
    let mut stack: Vec<usize> = roots.filter_map(arg_service).collect();
    while let Some(i) = stack.pop() {
        if !std::mem::replace(&mut seen[i], true) {
            stack.extend(services[i].args.iter().filter_map(arg_service));
        }
    }
    (0..services.len()).filter(|&i| seen[i]).collect()
}

/// The `:name` segments of a route path.
pub fn path_params(path: &str) -> impl Iterator<Item = &str> {
    path.split('/').filter_map(|s| s.strip_prefix(':'))
}

/// Routes and parameters: one handler per method and path; path params (in order), then `query`, then `body`.
fn check_endpoints(facts: &Facts, diags: &mut Vec<Diag>) {
    // Keyed with the params unnamed: Bun can't tell `/a/:id` from `/a/:slug`.
    let mut routes: HashMap<(Verb, String), (&Endpoint, &str)> = HashMap::new();
    for e in &facts.endpoints {
        let mut error = |at: usize, code: &'static str, message: String| {
            diags.push(Diag { file: e.file.clone(), at, code, message, inject: None, param_at: None });
        };
        for m in &e.methods {
            let name = format!("{}.{}", e.class.text, m.name);
            let verb = m.verb.as_str();
            let key = m.path.split('/').map(|s| if s.starts_with(':') { ":" } else { s }).collect::<Vec<_>>().join("/");
            match routes.get(&(m.verb, key.clone())) {
                Some((first, method)) => {
                    let message = format!("{verb} {} is handled twice: {}.{method} ({}) and {name} ({})", m.path, first.class.text, first.file, e.file);
                    error(m.at, "ZDI13", message);
                }
                None => {
                    routes.insert((m.verb, key), (e, m.name.as_str()));
                }
            }
            let names: Vec<&str> = path_params(&m.path).collect();
            if let Some(r) = names.iter().find(|n| matches!(**n, "query" | "body")) {
                error(m.at, "ZDI14", format!("{name}: :{r} in {} is reserved: a path parameter can't be named query or body", m.path));
                continue;
            }
            let mut bad = false;
            for p in &m.params {
                match p.kind {
                    ParamKind::Other => {
                        error(p.at, "ZDI17", format!("{name}: {} is not a path parameter of {}, nor query or body", p.name, m.path));
                    }
                    ParamKind::Body if !matches!(m.verb, Verb::Post | Verb::Put | Verb::Patch | Verb::Query) => {
                        error(p.at, "ZDI16", format!("{name}: {verb} takes no body (only POST, PUT, PATCH and QUERY do)"));
                    }
                    ParamKind::Query if p.keys.is_none() => {
                        error(p.at, "ZDI18", format!("{name}: query must be an object type, not {}", p.ty));
                    }
                    _ => continue,
                }
                bad = true;
            }
            if bad {
                continue;
            }
            let n = names.len();
            let in_order = m.params.len() >= n
                && m.params[..n].iter().zip(&names).all(|(p, name)| p.kind == ParamKind::Path && p.name == *name)
                && m.params[n..].windows(2).all(|w| w[0].kind == ParamKind::Query && w[1].kind == ParamKind::Body)
                && m.params[n..].iter().all(|p| p.kind != ParamKind::Path)
                && m.params.len() <= n + 2;
            if !in_order {
                let message = if n == 0 {
                    format!("{name}: parameters must be query, then body")
                } else {
                    format!("{name}: parameters must be the path parameters of {} in order ({}), then query, then body", m.path, names.join(", "))
                };
                error(m.at, "ZDI15", message);
            }
        }
    }
}

/// A key match (the key equals the parameter name) whose registration the analyzer listed in `badKeys`.
fn mismatched(facts: &Facts, prm: &Param, s: &Service, (pi, ri): Origin) -> bool {
    !prm.bad_keys.is_empty()
        && s.reg.key.as_deref() == Some(prm.name.as_str())
        && prm.bad_keys.iter().any(|b| {
            b.rsplit_once(':').is_some_and(|(class, n)| class == facts.providers[pi].class.id && n.parse() == Ok(ri))
        })
}

fn zdi12(prm: &Param, s: &Service) -> String {
    format!("{}: key \"{}\" provides {}, which is not assignable to {}", prm.name, prm.name, s.reg.service.text, prm.ty.text)
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
    use crate::di::model::{Component, EndpointMethod, EndpointParam, FactError, Facts, Factory, Lifetime, Mount, Param, Provider, Registration, TypeRef};

    fn ty(name: &str) -> TypeRef {
        TypeRef { id: format!("m.ts#{name}"), text: name.into(), module: Some("m".into()), export: Some(name.into()) }
    }

    fn param(name: &str, t: &str) -> Param {
        Param { name: name.into(), optional: false, promise: false, ty: ty(t), file: "params.ts".into(), at: 11, bad_keys: vec![] }
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
            dispose_optional: false,
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
            factory: Some(Factory { owner: ty("Factories"), member: Some("load".into()) }),
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
                id: format!("{name}.xzor.ts#default"),
                text: name.into(),
                module: Some(format!("{name}.xzor")),
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
        assert_eq!(d[0].param_at, Some(("params.ts".into(), 11)));
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
            [Diag { file: "s.ts".into(), at: 4, code: "ZDI11", message: "Hidden must be exported to be injected".into(), inject: None, param_at: None }]
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
        assert_eq!((d[0].file.as_str(), d[0].at, d[0].inject.as_deref()), ("Counter.xzor", 0, Some("db")));
        assert_eq!(d[0].param_at, None);
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
        assert_eq!((d[0].file.as_str(), d[0].at, d[0].inject.as_deref()), ("Counter.xzor", 0, Some("db")));
        assert_eq!(d[0].message, "IDatabase (injected as db in Counter) is not provided: no @Run application");
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
        assert_eq!(d[0].param_at, Some(("params.ts".into(), 11)));
        assert_eq!(d[0].message, "ILogger (needed by Database in provider P) is ambiguous: a, b");
    }

    fn bad(p: Param, keys: &[&str]) -> Param {
        Param { bad_keys: keys.iter().map(|k| k.to_string()).collect(), file: "server.ts".into(), at: 42, ..p }
    }

    #[test]
    fn zdi12_key_type_mismatch() {
        let port = keyed("port", single("Port", "Port", vec![]));
        let f = facts(vec![provider("P", &[], vec![port.clone(), single("Server", "Server", vec![bad(param("port", "Text"), &["m.ts#P:0"])])])]);
        let d = err(&f);
        assert_eq!(codes(&d), ["ZDI12"]);
        assert_eq!((d[0].file.as_str(), d[0].at, d[0].inject.as_deref()), ("P.ts", 7, None));
        assert_eq!(d[0].param_at, Some(("server.ts".into(), 42)));
        assert_eq!(d[0].message, "port: key \"port\" provides Port, which is not assignable to Text");

        // The id is the registration's origin, through imports.
        let f = facts(vec![
            provider("App", &["Data"], vec![single("Server", "Server", vec![bad(param("port", "Text"), &["m.ts#Data:0"])])]),
            provider("Data", &[], vec![port.clone()]),
        ]);
        assert_eq!(codes(&err(&f)), ["ZDI12"]);
        let f = facts(vec![
            provider("App", &["Data"], vec![single("Server", "Server", vec![bad(param("port", "Text"), &["m.ts#App:0"])])]),
            provider("Data", &[], vec![port.clone()]),
        ]);
        ok(&f);

        let f = Facts {
            components: vec![component("Counter", vec![bad(param("port", "Text"), &["m.ts#Application:0"])])],
            ..facts(vec![mounted(provider("Application", &[], vec![port]))])
        };
        let d = err(&f);
        assert_eq!(codes(&d), ["ZDI12"]);
        assert_eq!((d[0].file.as_str(), d[0].inject.as_deref(), d[0].param_at.as_ref()), ("Counter.xzor", Some("port"), None));
    }

    #[test]
    fn keyed_supertype_is_not_a_mismatch() {
        // The analyzer leaves `badKeys` empty when the keyed SystemClock implements IClock.
        let f = facts(vec![provider(
            "P",
            &[],
            vec![keyed("clock", single("SystemClock", "SystemClock", vec![])), single("Server", "Server", vec![param("clock", "IClock")])],
        )]);
        assert_eq!(ok(&f)[0].services[1].args, [Arg::Service(0)]);
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
        assert_eq!(d[0].message, "@Run is declared on more than one class: Application, Other");
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

    fn eparam(name: &str, kind: ParamKind) -> EndpointParam {
        let keys = (kind == ParamKind::Query).then(Vec::new);
        EndpointParam { name: name.into(), kind, ty: "T".into(), optional: false, conv: None, keys, any_key: false, at: 50 }
    }

    fn method(name: &str, verb: Verb, path: &str, params: Vec<EndpointParam>) -> EndpointMethod {
        EndpointMethod { name: name.into(), verb, pattern: String::new(), path: path.into(), params, returns_promise: false, at: 40 }
    }

    fn endpoint(name: &str, ctor: Vec<Param>, methods: Vec<EndpointMethod>) -> Endpoint {
        Endpoint { class: ty(name), file: format!("{name}.ts"), at: 30, prefix: String::new(), ctor, methods }
    }

    fn served(providers: Vec<Provider>, endpoints: Vec<Endpoint>) -> Facts {
        let server = Server { class: providers[0].class.clone(), file: providers[0].file.clone(), at: 2, root: None };
        Facts { servers: vec![server], endpoints, ..facts(providers) }
    }

    #[test]
    fn endpoint_constructors_resolve_against_the_server_app() {
        let f = served(
            vec![provider("App", &[], vec![single("Store", "Store", vec![])])],
            vec![endpoint("Posts", vec![param("store", "Store")], vec![method("list", Verb::Get, "/api", vec![])])],
        );
        let r = ok(&f);
        assert_eq!(r[0].server.as_ref().map(|s| s.at), Some(2));
        assert_eq!(r[0].endpoints[0].1, [Arg::Service(0)]);

        let f = served(vec![provider("App", &[], vec![])], vec![endpoint("Posts", vec![param("store", "Store")], vec![])]);
        let d = err(&f);
        assert_eq!(codes(&d), ["ZDI02"]);
        assert_eq!((d[0].file.as_str(), d[0].at, d[0].param_at.clone()), ("Posts.ts", 30, Some(("params.ts".into(), 11))));
        assert_eq!(d[0].message, "Store (needed by Posts in provider App) is not registered or imported");
    }

    #[test]
    fn endpoint_routes_and_parameters() {
        let check = |methods: Vec<EndpointMethod>| -> Vec<(&'static str, String)> {
            match resolve(&served(vec![provider("App", &[], vec![])], vec![endpoint("A", vec![], methods)])) {
                Ok(_) => vec![],
                Err(d) => d.into_iter().map(|d| (d.code, d.message)).collect(),
            }
        };
        use ParamKind::*;
        let path = |n: &str| eparam(n, Path);
        // Bun can't tell params apart by name.
        let dup = check(vec![method("a", Verb::Get, "/x/:id", vec![path("id")]), method("b", Verb::Get, "/x/:slug", vec![path("slug")])]);
        assert_eq!(dup, [("ZDI13", "GET /x/:slug is handled twice: A.a (A.ts) and A.b (A.ts)".to_string())]);
        assert_eq!(check(vec![method("a", Verb::Get, "/x/:id", vec![path("id")]), method("b", Verb::Delete, "/x/:id", vec![path("id")])]), []);
        let ok_order = vec![path("org"), path("id"), eparam("query", Query), eparam("body", Body)];
        assert_eq!(check(vec![method("a", Verb::Query, "/:org/:id", ok_order)]), []);
        assert_eq!(check(vec![method("a", Verb::Post, "/x", vec![eparam("body", Body), eparam("query", Query)])]), [("ZDI15", "A.a: parameters must be query, then body".to_string())]);
        assert_eq!(check(vec![method("a", Verb::Get, "/:a/:b", vec![path("a")])])[0].0, "ZDI15");
        assert_eq!(check(vec![method("a", Verb::Get, "/:body", vec![])])[0].0, "ZDI14");
        assert_eq!(check(vec![method("a", Verb::Delete, "/x", vec![eparam("body", Body)])])[0].0, "ZDI16");
        assert_eq!(check(vec![method("a", Verb::Get, "/x", vec![eparam("x", Other)])])[0].0, "ZDI17");
        assert_eq!(check(vec![method("a", Verb::Get, "/x", vec![EndpointParam { keys: None, ..eparam("query", Query) }])])[0].0, "ZDI18");
    }
}
