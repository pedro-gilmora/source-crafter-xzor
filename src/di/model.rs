//! Rust mirror of the JSON facts printed by the Bun analyzer (`src/di.ts`).

use crate::json::Json;

#[derive(Debug, Clone, PartialEq)]
pub struct TypeRef {
    /// Identity: `module.ts#Export`, or the bare text for primitives and lib types.
    pub id: String,
    pub text: String,
    /// Import path without extension (`.zor/` stripped); `None` for primitives and lib types.
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
    /// Project-relative file declaring the parameter (keeps `.zor/`).
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
    /// Real project-relative path (keeps `.zor/`).
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

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Facts {
    pub providers: Vec<Provider>,
    pub components: Vec<Component>,
    pub errors: Vec<FactError>,
}

impl Facts {
    pub fn from_json(text: &str) -> Result<Facts, String> {
        let root = Json::parse(text).map_err(|e| format!("di facts: {e}"))?;
        Ok(Facts {
            providers: list(&root, "providers", "", provider)?,
            components: list(&root, "components", "", component)?,
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

#[cfg(test)]
mod tests {
    use super::*;

    const FACTS: &str = r##"{"providers":[{"class":{"id":"main.ts#Application","text":"Application","module":"main","export":"Application"},"file":"main.ts","at":847,"imports":[{"id":"services/data.ts#DataServices","text":"DataServices","module":"services/data","export":"DataServices"}],"registrations":[{"lifetime":"singleton","service":{"id":"main.ts#Cache","text":"Cache","module":"main","export":"Cache"},"impl":null,"key":"cache","factory":{"owner":{"id":"main.ts#Factories","text":"Factories","module":"main","export":"Factories"},"member":"_loadCache"},"async":true,"params":[],"dispose":null,"disposeOptional":false,"at":794},{"lifetime":"transient","service":{"id":"main.ts#Report","text":"Report","module":"main","export":"Report"},"impl":{"id":"main.ts#Report","text":"Report","module":"main","export":"Report"},"key":null,"factory":null,"async":false,"params":[{"name":"cache","optional":false,"promise":true,"file":"main.ts","at":300,"badKeys":["main.ts#Application:0"],"type":{"id":"main.ts#Cache","text":"Cache","module":"main","export":"Cache"}},{"name":"requestId","optional":true,"promise":false,"file":"main.ts","at":330,"badKeys":[],"type":{"id":"string","text":"string","module":null,"export":null}}],"dispose":"Symbol.asyncDispose","disposeOptional":true,"at":727}],"mount":{"component":{"id":"App.tszor.ts#default","text":"App","module":"App.tszor","export":"default"},"target":"app","at":662}}],"components":[{"class":{"id":"Counter.tszor.ts#default","text":"Counter","module":"Counter.tszor","export":"default"},"injects":[{"name":"db","optional":false,"promise":false,"file":".zor/Counter.tszor.ts","at":250,"badKeys":[],"type":{"id":"services/data.ts#IDatabase","text":"IDatabase","module":"services/data","export":"IDatabase"}}]}],"errors":[{"file":"services/hidden.ts","at":112,"message":"Hidden must be exported to be injected"}]}"##;

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
        assert_eq!(mount.component.id, "App.tszor.ts#default");
        assert_eq!(mount.component.module.as_deref(), Some("App.tszor"));
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
        let db = Param { name: "db".into(), optional: false, promise: false, ty: t("services/data", "IDatabase"), file: ".zor/Counter.tszor.ts".into(), at: 250, bad_keys: vec![] };
        assert_eq!(c.injects, vec![db]);

        assert_eq!(facts.errors, vec![FactError { file: "services/hidden.ts".into(), at: 112, message: "Hidden must be exported to be injected".into() }]);
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
