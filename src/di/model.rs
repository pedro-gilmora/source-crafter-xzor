//! Rust mirror of the JSON facts printed by the Bun analyzer (`src/di.ts`).

use crate::json::Json;

#[derive(Debug, Clone, PartialEq)]
pub struct TypeRef {
    /// Identity: `module.ts#Export`, or the bare text for primitives and lib types.
    pub id: String,
    pub text: String,
    /// Import path without extension (`.xzor/` stripped); `None` for primitives and lib types.
    pub module: Option<String>,
    pub export: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Param {
    pub name: String,
    pub optional: bool,
    /// Typed `Promise<T>`: receives the unawaited promise.
    pub promise: bool,
    pub ty: TypeRef,
    /// Project-relative file declaring the parameter (keeps `.xzor/`).
    pub file: String,
    /// UTF-16 code-unit offset of the parameter name in `file`.
    pub at: usize,
    /// `<provider class id>:<registration index>` of keyed registrations named like this parameter whose type does not fit it.
    pub bad_keys: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lifetime {
    Singleton,
    Scoped,
    Transient,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dispose {
    Method,
    Symbol,
    AsyncSymbol,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Factory {
    /// The class of a static method, or the function itself when `member` is `None`.
    pub owner: TypeRef,
    pub member: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Registration {
    pub lifetime: Lifetime,
    pub service: TypeRef,
    pub impl_: Option<TypeRef>,
    pub key: Option<String>,
    pub factory: Option<Factory>,
    pub is_async: bool,
    pub params: Vec<Param>,
    pub dispose: Option<Dispose>,
    /// The disposer member is optional (`dispose?()`).
    pub dispose_optional: bool,
    /// UTF-16 code-unit offset of the `@` in `file`.
    pub at: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Mount {
    pub component: TypeRef,
    pub target: String,
    /// UTF-16 code-unit offset of the `@`.
    pub at: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Provider {
    pub class: TypeRef,
    /// Real project-relative path (keeps `.xzor/`).
    pub file: String,
    /// UTF-16 code-unit offset of the class name.
    pub at: usize,
    pub imports: Vec<TypeRef>,
    pub registrations: Vec<Registration>,
    pub mount: Option<Mount>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Component {
    pub class: TypeRef,
    pub injects: Vec<Param>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FactError {
    pub file: String,
    /// UTF-16 code-unit offset.
    pub at: usize,
    pub message: String,
}

/// `@Run(Shell)` / `@Run()` on an `IServerApplication`.
#[derive(Debug, Clone, PartialEq)]
pub struct Server {
    pub class: TypeRef,
    pub file: String,
    /// UTF-16 code-unit offset of the `@` of `@Run`.
    pub at: usize,
    /// The views' root component.
    pub root: Option<TypeRef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Verb {
    Get,
    Post,
    Put,
    Patch,
    Delete,
    Query,
}

impl Verb {
    pub fn as_str(self) -> &'static str {
        match self {
            Verb::Get => "GET",
            Verb::Post => "POST",
            Verb::Put => "PUT",
            Verb::Patch => "PATCH",
            Verb::Delete => "DELETE",
            Verb::Query => "QUERY",
        }
    }
}

/// From the parameter's name: a `:param` of the path, `query`, `body`, else `Other` (not bindable).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParamKind {
    Path,
    Query,
    Body,
    Other,
}

/// How a path or query string is converted.
#[derive(Debug, Clone, PartialEq)]
pub enum Conv {
    String,
    Number,
    Boolean,
    /// A string-literal union (sorted values).
    Literals(Vec<String>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct QueryKey {
    pub name: String,
    pub optional: bool,
    pub conv: Conv,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EndpointParam {
    pub name: String,
    pub kind: ParamKind,
    /// The checker's text for the type (without `undefined` when optional).
    pub ty: String,
    pub optional: bool,
    /// Set for `Path` parameters.
    pub conv: Option<Conv>,
    /// Set for a `Query` parameter of object type.
    pub keys: Option<Vec<QueryKey>>,
    /// The `query` type has a string index signature, so every search param is read too.
    pub any_key: bool,
    pub at: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EndpointMethod {
    pub name: String,
    pub verb: Verb,
    /// As written; `""` for a bare decorator.
    pub pattern: String,
    /// Prefix and pattern joined.
    pub path: String,
    pub params: Vec<EndpointParam>,
    pub returns_promise: bool,
    /// UTF-16 code-unit offset of the method name.
    pub at: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Endpoint {
    pub class: TypeRef,
    pub file: String,
    /// UTF-16 code-unit offset of the class name.
    pub at: usize,
    pub prefix: String,
    pub ctor: Vec<Param>,
    pub methods: Vec<EndpointMethod>,
}

/// A value import of an `@Endpoints` class (`import { Posts }`, not `import type`).
#[derive(Debug, Clone, PartialEq)]
pub struct EndpointImport {
    /// Project-relative importing file (keeps `.xzor/`).
    pub file: String,
    /// The importing module, like `TypeRef.module`.
    pub module: String,
    /// UTF-16 code-unit offset of the imported name.
    pub at: usize,
    pub class: String,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Facts {
    pub providers: Vec<Provider>,
    pub components: Vec<Component>,
    pub servers: Vec<Server>,
    pub endpoints: Vec<Endpoint>,
    /// (module, specifier): a registered class's module importing `bun`, `bun:*` or `node:*`.
    pub server_imports: Vec<(String, String)>,
    pub endpoint_imports: Vec<EndpointImport>,
    pub errors: Vec<FactError>,
}

impl Facts {
    pub fn from_json(text: &str) -> Result<Facts, String> {
        let root = Json::parse(text).map_err(|e| format!("di facts: {e}"))?;
        Ok(Facts {
            providers: list(&root, "providers", "", provider)?,
            components: list(&root, "components", "", component)?,
            servers: list(&root, "servers", "", server)?,
            endpoints: list(&root, "endpoints", "", endpoint)?,
            server_imports: list(&root, "serverImports", "", |j, p| Ok((string(j, "module", p)?, string(j, "import", p)?)))?,
            endpoint_imports: list(&root, "endpointImports", "", |j, p| {
                Ok(EndpointImport { file: string(j, "file", p)?, module: string(j, "module", p)?, at: number(j, "at", p)?, class: string(j, "class", p)? })
            })?,
            errors: list(&root, "errors", "", |j, p| {
                Ok(FactError { file: string(j, "file", p)?, at: number(j, "at", p)?, message: string(j, "message", p)? })
            })?,
        })
    }
}

fn missing(path: &str, key: &str) -> String {
    if path.is_empty() { format!("di facts: missing {key}") } else { format!("di facts: missing {path}.{key}") }
}

fn field<'a>(j: &'a Json, key: &str, path: &str) -> Result<&'a Json, String> {
    j.get(key).ok_or_else(|| missing(path, key))
}

fn string(j: &Json, key: &str, path: &str) -> Result<String, String> {
    field(j, key, path)?.as_str().map(str::to_string).ok_or_else(|| missing(path, key))
}

fn number(j: &Json, key: &str, path: &str) -> Result<usize, String> {
    field(j, key, path)?.as_usize().ok_or_else(|| missing(path, key))
}

fn boolean(j: &Json, key: &str, path: &str) -> Result<bool, String> {
    match field(j, key, path)? {
        Json::Bool(b) => Ok(*b),
        _ => Err(missing(path, key)),
    }
}

/// A string or `null`; an absent key is an error.
fn opt_string(j: &Json, key: &str, path: &str) -> Result<Option<String>, String> {
    let v = field(j, key, path)?;
    if v.is_null() { Ok(None) } else { v.as_str().map(|s| Some(s.to_string())).ok_or_else(|| missing(path, key)) }
}

fn list<T>(j: &Json, key: &str, path: &str, f: impl Fn(&Json, &str) -> Result<T, String>) -> Result<Vec<T>, String> {
    let at = if path.is_empty() { key.to_string() } else { format!("{path}.{key}") };
    let items = field(j, key, path)?.as_array().ok_or_else(|| missing(path, key))?;
    items.iter().enumerate().map(|(i, item)| f(item, &format!("{at}[{i}]"))).collect()
}

fn type_ref(j: &Json, path: &str) -> Result<TypeRef, String> {
    Ok(TypeRef {
        id: string(j, "id", path)?,
        text: string(j, "text", path)?,
        module: opt_string(j, "module", path)?,
        export: opt_string(j, "export", path)?,
    })
}

fn sub_type_ref(j: &Json, key: &str, path: &str) -> Result<TypeRef, String> {
    type_ref(field(j, key, path)?, &join(path, key))
}

fn join(path: &str, key: &str) -> String {
    if path.is_empty() { key.to_string() } else { format!("{path}.{key}") }
}

fn param(j: &Json, path: &str) -> Result<Param, String> {
    Ok(Param {
        name: string(j, "name", path)?,
        optional: boolean(j, "optional", path)?,
        promise: boolean(j, "promise", path)?,
        ty: sub_type_ref(j, "type", path)?,
        file: string(j, "file", path)?,
        at: number(j, "at", path)?,
        bad_keys: list(j, "badKeys", path, |k, p| k.as_str().map(str::to_string).ok_or_else(|| format!("di facts: missing {p}")))?,
    })
}

fn registration(j: &Json, path: &str) -> Result<Registration, String> {
    let lifetime = match string(j, "lifetime", path)?.as_str() {
        "singleton" => Lifetime::Singleton,
        "scoped" => Lifetime::Scoped,
        "transient" => Lifetime::Transient,
        other => return Err(format!("di facts: unknown {path}.lifetime '{other}'")),
    };
    let dispose = match opt_string(j, "dispose", path)?.as_deref() {
        None => None,
        Some("dispose") => Some(Dispose::Method),
        Some("Symbol.dispose") => Some(Dispose::Symbol),
        Some("Symbol.asyncDispose") => Some(Dispose::AsyncSymbol),
        Some(other) => return Err(format!("di facts: unknown {path}.dispose '{other}'")),
    };
    let nullable = |key: &str| -> Result<Option<&Json>, String> {
        let v = field(j, key, path)?;
        Ok(if v.is_null() { None } else { Some(v) })
    };
    Ok(Registration {
        lifetime,
        service: sub_type_ref(j, "service", path)?,
        impl_: nullable("impl")?.map(|v| type_ref(v, &join(path, "impl"))).transpose()?,
        key: opt_string(j, "key", path)?,
        factory: nullable("factory")?
            .map(|v| {
                let p = join(path, "factory");
                Ok::<_, String>(Factory { owner: sub_type_ref(v, "owner", &p)?, member: opt_string(v, "member", &p)? })
            })
            .transpose()?,
        is_async: boolean(j, "async", path)?,
        params: list(j, "params", path, param)?,
        dispose,
        dispose_optional: boolean(j, "disposeOptional", path)?,
        at: number(j, "at", path)?,
    })
}

fn provider(j: &Json, path: &str) -> Result<Provider, String> {
    let mount = field(j, "mount", path)?;
    Ok(Provider {
        class: sub_type_ref(j, "class", path)?,
        file: string(j, "file", path)?,
        at: number(j, "at", path)?,
        imports: list(j, "imports", path, type_ref)?,
        registrations: list(j, "registrations", path, registration)?,
        mount: if mount.is_null() {
            None
        } else {
            let p = join(path, "mount");
            Some(Mount { component: sub_type_ref(mount, "component", &p)?, target: string(mount, "target", &p)?, at: number(mount, "at", &p)? })
        },
    })
}

fn component(j: &Json, path: &str) -> Result<Component, String> {
    Ok(Component { class: sub_type_ref(j, "class", path)?, injects: list(j, "injects", path, param)? })
}

fn server(j: &Json, path: &str) -> Result<Server, String> {
    let root = field(j, "root", path)?;
    Ok(Server {
        class: sub_type_ref(j, "class", path)?,
        file: string(j, "file", path)?,
        at: number(j, "at", path)?,
        root: if root.is_null() { None } else { Some(type_ref(root, &join(path, "root"))?) },
    })
}

fn conv(j: &Json, path: &str) -> Result<Conv, String> {
    if let Some(items) = j.as_array() {
        return items.iter().map(|v| v.as_str().map(str::to_string).ok_or_else(|| format!("di facts: missing {path}"))).collect::<Result<_, _>>().map(Conv::Literals);
    }
    match j.as_str() {
        Some("string") => Ok(Conv::String),
        Some("number") => Ok(Conv::Number),
        Some("boolean") => Ok(Conv::Boolean),
        _ => Err(format!("di facts: unknown {path}")),
    }
}

fn endpoint_param(j: &Json, path: &str) -> Result<EndpointParam, String> {
    let kind = match string(j, "kind", path)?.as_str() {
        "path" => ParamKind::Path,
        "query" => ParamKind::Query,
        "body" => ParamKind::Body,
        "other" => ParamKind::Other,
        other => return Err(format!("di facts: unknown {path}.kind '{other}'")),
    };
    let c = field(j, "conv", path)?;
    let keys = field(j, "keys", path)?;
    Ok(EndpointParam {
        name: string(j, "name", path)?,
        kind,
        ty: string(j, "type", path)?,
        optional: boolean(j, "optional", path)?,
        conv: if c.is_null() { None } else { Some(conv(c, &join(path, "conv"))?) },
        keys: if keys.is_null() {
            None
        } else {
            Some(list(j, "keys", path, |k, p| Ok(QueryKey { name: string(k, "name", p)?, optional: boolean(k, "optional", p)?, conv: conv(field(k, "conv", p)?, &join(p, "conv"))? }))?)
        },
        any_key: boolean(j, "anyKey", path)?,
        at: number(j, "at", path)?,
    })
}

fn endpoint_method(j: &Json, path: &str) -> Result<EndpointMethod, String> {
    let verb = match string(j, "verb", path)?.as_str() {
        "GET" => Verb::Get,
        "POST" => Verb::Post,
        "PUT" => Verb::Put,
        "PATCH" => Verb::Patch,
        "DELETE" => Verb::Delete,
        "QUERY" => Verb::Query,
        other => return Err(format!("di facts: unknown {path}.verb '{other}'")),
    };
    Ok(EndpointMethod {
        name: string(j, "name", path)?,
        verb,
        pattern: string(j, "pattern", path)?,
        path: string(j, "path", path)?,
        params: list(j, "params", path, endpoint_param)?,
        returns_promise: boolean(j, "returnsPromise", path)?,
        at: number(j, "at", path)?,
    })
}

fn endpoint(j: &Json, path: &str) -> Result<Endpoint, String> {
    Ok(Endpoint {
        class: sub_type_ref(j, "class", path)?,
        file: string(j, "file", path)?,
        at: number(j, "at", path)?,
        prefix: string(j, "prefix", path)?,
        ctor: list(j, "ctor", path, param)?,
        methods: list(j, "methods", path, endpoint_method)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const FACTS: &str = r##"{"servers":[],"endpoints":[],"serverImports":[],"endpointImports":[],"providers":[{"class":{"id":"main.ts#Application","text":"Application","module":"main","export":"Application"},"file":"main.ts","at":847,"imports":[{"id":"services/data.ts#DataServices","text":"DataServices","module":"services/data","export":"DataServices"}],"registrations":[{"lifetime":"singleton","service":{"id":"main.ts#Cache","text":"Cache","module":"main","export":"Cache"},"impl":null,"key":"cache","factory":{"owner":{"id":"main.ts#Factories","text":"Factories","module":"main","export":"Factories"},"member":"_loadCache"},"async":true,"params":[],"dispose":null,"disposeOptional":false,"at":794},{"lifetime":"transient","service":{"id":"main.ts#Report","text":"Report","module":"main","export":"Report"},"impl":{"id":"main.ts#Report","text":"Report","module":"main","export":"Report"},"key":null,"factory":null,"async":false,"params":[{"name":"cache","optional":false,"promise":true,"file":"main.ts","at":300,"badKeys":["main.ts#Application:0"],"type":{"id":"main.ts#Cache","text":"Cache","module":"main","export":"Cache"}},{"name":"requestId","optional":true,"promise":false,"file":"main.ts","at":330,"badKeys":[],"type":{"id":"string","text":"string","module":null,"export":null}}],"dispose":"Symbol.asyncDispose","disposeOptional":true,"at":727}],"mount":{"component":{"id":"App.xzor.ts#default","text":"App","module":"App.xzor","export":"default"},"target":"app","at":662}}],"components":[{"class":{"id":"Counter.xzor.ts#default","text":"Counter","module":"Counter.xzor","export":"default"},"injects":[{"name":"db","optional":false,"promise":false,"file":".xzor/Counter.xzor.ts","at":250,"badKeys":[],"type":{"id":"services/data.ts#IDatabase","text":"IDatabase","module":"services/data","export":"IDatabase"}}]}],"errors":[{"file":"services/hidden.ts","at":112,"message":"Hidden must be exported to be injected"}]}"##;

    fn t(module: &str, name: &str) -> TypeRef {
        TypeRef { id: format!("{module}.ts#{name}"), text: name.into(), module: Some(module.into()), export: Some(name.into()) }
    }

    #[test]
    fn parses_facts() {
        let facts = Facts::from_json(FACTS).unwrap();

        let p = &facts.providers[0];
        assert_eq!((p.class.clone(), p.file.as_str(), p.at), (t("main", "Application"), "main.ts", 847));
        assert_eq!(p.imports, vec![t("services/data", "DataServices")]);
        let mount = p.mount.as_ref().unwrap();
        assert_eq!(mount.component.id, "App.xzor.ts#default");
        assert_eq!(mount.component.module.as_deref(), Some("App.xzor"));
        assert_eq!((mount.target.as_str(), mount.at), ("app", 662));

        let cache = &p.registrations[0];
        assert_eq!(cache.lifetime, Lifetime::Singleton);
        assert_eq!(cache.service, t("main", "Cache"));
        assert_eq!(cache.impl_, None);
        assert_eq!(cache.key.as_deref(), Some("cache"));
        assert_eq!(cache.factory, Some(Factory { owner: t("main", "Factories"), member: Some("_loadCache".into()) }));
        assert!(cache.is_async);
        assert_eq!((cache.dispose, cache.dispose_optional, cache.at), (None, false, 794));

        let report = &p.registrations[1];
        assert_eq!(report.lifetime, Lifetime::Transient);
        assert_eq!(report.impl_, Some(t("main", "Report")));
        assert_eq!(report.key, None);
        assert!(!report.is_async);
        assert_eq!(report.dispose, Some(Dispose::AsyncSymbol));
        assert!(report.dispose_optional);
        assert_eq!(
            report.params,
            vec![
                Param {
                    name: "cache".into(),
                    optional: false,
                    promise: true,
                    ty: t("main", "Cache"),
                    file: "main.ts".into(),
                    at: 300,
                    bad_keys: vec!["main.ts#Application:0".into()],
                },
                Param {
                    name: "requestId".into(),
                    optional: true,
                    promise: false,
                    ty: TypeRef { id: "string".into(), text: "string".into(), module: None, export: None },
                    file: "main.ts".into(),
                    at: 330,
                    bad_keys: vec![],
                },
            ]
        );

        let c = &facts.components[0];
        assert_eq!(c.class.text, "Counter");
        let db = Param { name: "db".into(), optional: false, promise: false, ty: t("services/data", "IDatabase"), file: ".xzor/Counter.xzor.ts".into(), at: 250, bad_keys: vec![] };
        assert_eq!(c.injects, vec![db]);

        assert_eq!(facts.errors, vec![FactError { file: "services/hidden.ts".into(), at: 112, message: "Hidden must be exported to be injected".into() }]);
    }

    const SERVER_FACTS: &str = r##"{"providers":[],"components":[],"errors":[],"serverImports":[{"module":"server/db","import":"bun:sqlite"}],"endpointImports":[{"file":".xzor/client/Home.xzor.ts","module":"client/Home.xzor","at":9,"class":"Posts"}],"servers":[{"class":{"id":"server/app.ts#App","text":"App","module":"server/app","export":"App"},"file":"server/app.ts","at":180,"root":{"id":"client/Shell.xzor.ts#default","text":"Shell","module":"client/Shell.xzor","export":"default"}}],"endpoints":[{"class":{"id":"server/api/posts.ts#Posts","text":"Posts","module":"server/api/posts","export":"Posts"},"file":"server/api/posts.ts","at":210,"prefix":"/api/posts","ctor":[],"methods":[{"name":"get","verb":"GET","pattern":":slug","path":"/api/posts/:slug","returnsPromise":false,"at":300,"params":[{"name":"slug","kind":"path","type":"string","optional":false,"conv":"string","keys":null,"anyKey":false,"at":304},{"name":"query","kind":"query","type":"{ tag?: string; }","optional":true,"conv":null,"keys":[{"name":"tag","optional":true,"conv":["a","b"]}],"anyKey":true,"at":320},{"name":"x","kind":"other","type":"boolean","optional":false,"conv":null,"keys":null,"anyKey":false,"at":340}]},{"name":"create","verb":"QUERY","pattern":"","path":"/api/posts","returnsPromise":true,"at":400,"params":[{"name":"body","kind":"body","type":"NewPost","optional":false,"conv":null,"keys":null,"anyKey":false,"at":410}]}]}]}"##;

    #[test]
    fn parses_servers_and_endpoints() {
        let f = Facts::from_json(SERVER_FACTS).unwrap();
        let s = &f.servers[0];
        assert_eq!((s.class.clone(), s.file.as_str(), s.at), (t("server/app", "App"), "server/app.ts", 180));
        assert_eq!(s.root.as_ref().map(|r| r.id.as_str()), Some("client/Shell.xzor.ts#default"));
        let e = &f.endpoints[0];
        assert_eq!((e.class.clone(), e.file.as_str(), e.at, e.prefix.as_str(), e.ctor.len()), (t("server/api/posts", "Posts"), "server/api/posts.ts", 210, "/api/posts", 0));
        let [get, create] = &e.methods[..] else { panic!("{:?}", e.methods) };
        assert_eq!((get.name.as_str(), get.verb, get.pattern.as_str(), get.path.as_str(), get.returns_promise, get.at), ("get", Verb::Get, ":slug", "/api/posts/:slug", false, 300));
        assert_eq!((create.verb, create.pattern.as_str(), create.returns_promise), (Verb::Query, "", true));
        assert_eq!(
            get.params,
            vec![
                EndpointParam { name: "slug".into(), kind: ParamKind::Path, ty: "string".into(), optional: false, conv: Some(Conv::String), keys: None, any_key: false, at: 304 },
                EndpointParam {
                    name: "query".into(),
                    kind: ParamKind::Query,
                    ty: "{ tag?: string; }".into(),
                    optional: true,
                    conv: None,
                    keys: Some(vec![QueryKey { name: "tag".into(), optional: true, conv: Conv::Literals(vec!["a".into(), "b".into()]) }]),
                    any_key: true,
                    at: 320,
                },
                EndpointParam { name: "x".into(), kind: ParamKind::Other, ty: "boolean".into(), optional: false, conv: None, keys: None, any_key: false, at: 340 },
            ]
        );
        assert_eq!(create.params[0].kind, ParamKind::Body);
        assert_eq!(f.server_imports, [("server/db".to_string(), "bun:sqlite".to_string())]);
        assert_eq!(f.endpoint_imports, [EndpointImport { file: ".xzor/client/Home.xzor.ts".into(), module: "client/Home.xzor".into(), at: 9, class: "Posts".into() }]);
        assert_eq!(Facts::from_json(&SERVER_FACTS.replace(r#""verb":"QUERY""#, r#""verb":"HEAD""#)), Err("di facts: unknown endpoints[0].methods[1].verb 'HEAD'".into()));
    }

    #[test]
    fn maps_dispose_members() {
        let with = |d: &str| FACTS.replace(r#""dispose":"Symbol.asyncDispose""#, &format!(r#""dispose":{d}"#));
        let dispose = |d: &str| Facts::from_json(&with(d)).unwrap().providers[0].registrations[1].dispose;
        assert_eq!(dispose("null"), None);
        assert_eq!(dispose(r#""dispose""#), Some(Dispose::Method));
        assert_eq!(dispose(r#""Symbol.dispose""#), Some(Dispose::Symbol));
        assert_eq!(dispose(r#""Symbol.asyncDispose""#), Some(Dispose::AsyncSymbol));
    }

    #[test]
    fn reports_missing_field_path() {
        let broken = FACTS.replace(r#""lifetime":"transient","#, "");
        assert_eq!(Facts::from_json(&broken), Err("di facts: missing providers[0].registrations[1].lifetime".into()));
        let broken = FACTS.replace(r#""target":"app","#, "");
        assert_eq!(Facts::from_json(&broken), Err("di facts: missing providers[0].mount.target".into()));
        assert_eq!(Facts::from_json("{}"), Err("di facts: missing providers".into()));
    }
}
