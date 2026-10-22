use std::fmt;
use std::ops::Deref;

/// Source text plus its byte offset in the `.xzor` file. Equality ignores the offset.
#[derive(Clone, Default)]
pub struct Src {
    pub text: String,
    pub at: usize,
}

impl Src {
    /// Offset for text that is not a verbatim copy of the source (e.g. it contained `@@`).
    pub const UNMAPPED: usize = usize::MAX;

    pub fn new(text: impl Into<String>, at: usize) -> Self {
        Src { text: text.into(), at }
    }
}

impl Deref for Src {
    type Target = str;
    fn deref(&self) -> &str {
        &self.text
    }
}

impl PartialEq for Src {
    fn eq(&self, other: &Self) -> bool {
        self.text == other.text
    }
}

impl PartialEq<&str> for Src {
    fn eq(&self, other: &&str) -> bool {
        self.text == *other
    }
}

impl fmt::Debug for Src {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}@{}", self.text, self.at)
    }
}

impl fmt::Display for Src {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.text)
    }
}

impl From<&str> for Src {
    fn from(s: &str) -> Self {
        Src::new(s, 0)
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Inject {
    pub ty: Src,
    pub name: Src,
}

/// A `@page "pattern"` line, optionally tagged with `as <tag>`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PageRoute {
    pub pattern: Src,
    pub tag: Option<Src>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Document {
    pub pages: Vec<PageRoute>,
    /// `@typeparam` declarations, e.g. `T extends object`.
    pub type_params: Vec<Src>,
    /// `@inherits Base<T>`: the base class instead of `ComponentBase`.
    pub inherits: Option<Src>,
    /// Compiled to DOM bindings with no render pass (base `FineComponent`): the default; `@render` opts out.
    pub fine: bool,
    /// `@async`: importers load the component on first use (a chunk of its own in a split bundle).
    pub lazy: bool,
    /// `@cached`: leaving the tree keeps the instance and its DOM for when it comes back.
    pub cached: bool,
    /// `@implements A, B`.
    pub implements: Vec<Src>,
    /// `@attribute dec(args)`: class decorators.
    pub attributes: Vec<Src>,
    /// `@inject Type name`: services passed to the constructor.
    pub injects: Vec<Inject>,
    /// What follows `@import`, without a trailing `;`.
    pub imports: Vec<Src>,
    /// Raw bodies of `@code { ... }` blocks; they become class members.
    pub code: Vec<Src>,
    /// The same blocks split into TypeScript and markup used as values (`RenderFragment`s).
    pub code_parts: Vec<Vec<CodePart>>,
    /// `@module { ... }`: module-level code (TypeScript and markup values) outside the class.
    pub module: Option<Vec<CodePart>>,
    /// The component's top-level `<style>` (or its sibling `X.css.xzor`): raw CSS, lowered by `style::lower`.
    pub style: Option<StyleBlock>,
    pub nodes: Vec<Node>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct StyleBlock {
    pub body: Src,
    /// `<style global>` / `@global`: no `@scope` wrapper.
    pub global: bool,
    /// Offset of the `<style` tag.
    pub at: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CodePart {
    Ts(Src),
    Markup(Element),
    /// Markup at statement start or a `@:` line inside `@{ }`, rendered in place.
    Render(Vec<Node>),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Node {
    Text(String),
    Expr(Src),
    Element(Element),
    If {
        branches: Vec<(Src, Vec<Node>)>,
        otherwise: Option<Vec<Node>>,
    },
    For {
        head: Src,
        /// `@key(expr)`: what matches a pass to its row; a pass counter when absent.
        key: Option<Src>,
        body: Vec<Node>,
        /// `} else { }`: rendered when no pass ran.
        otherwise: Option<Vec<Node>>,
    },
    While {
        cond: Src,
        key: Option<Src>,
        body: Vec<Node>,
        otherwise: Option<Vec<Node>>,
    },
    /// `@{ statements }` inside the template.
    Code(Vec<CodePart>),
    Switch {
        subject: Src,
        cases: Vec<Case>,
    },
    /// `@cascade:name(value)` or `@cascade:name(value, fixed)`: a region providing `value`.
    Cascade {
        name: Src,
        value: Src,
        fixed: bool,
        body: Vec<Node>,
    },
    /// `@ClientRoutes(route) { ... }` or `@ServerRoutes(route) { ... }`: the project's routes block.
    Routes {
        engine: crate::routes::Engine,
        /// The name the sections see the route state under.
        var: Src,
        sections: Vec<RouteSectionNode>,
    },
    /// `@slot`, `@slot:name(args) { fallback }` in a component's own template.
    Slot(Slot),
    /// `@slot name(params) { body }` as a direct child of a component tag.
    SlotFill(SlotFill),
    /// `@attr:name="value"`: an attribute of the enclosing element while this node renders.
    ParentAttr(Attr),
    /// `@once(expr)` (one `Expr`) or `@once { }`: built once, with nothing bound.
    Once(Vec<Node>),
}

/// One section of a routes block and the markup it renders.
#[derive(Debug, Clone, PartialEq)]
pub struct RouteSectionNode {
    pub kind: RouteSectionKind,
    pub body: Vec<Node>,
}

/// What a routes-block section matches, with the names it binds.
#[derive(Debug, Clone, PartialEq)]
pub enum RouteSectionKind {
    /// `@<tag>(page)`: any `@page` route carrying `tag`.
    Tag { tag: Src, page: Src },
    /// `@/re/flags(page?)`: the regex literal, verbatim.
    Regex { re: Src, page: Option<Src> },
    /// `@"pattern"(page?)`: a Bun.serve pattern, without its quotes.
    Pattern { pattern: Src, page: Option<Src> },
    /// `@notFound`.
    NotFound,
    /// `@catch(e)`.
    Catch { error: Src },
    /// `@default(page)`, always last.
    Default { page: Src },
}

impl RouteSectionKind {
    /// The name the section binds in its body: the page fragment, or the `@catch` error.
    pub fn binding(&self) -> Option<&Src> {
        match self {
            RouteSectionKind::Tag { page, .. } | RouteSectionKind::Default { page } => Some(page),
            RouteSectionKind::Regex { page, .. } | RouteSectionKind::Pattern { page, .. } => page.as_ref(),
            RouteSectionKind::Catch { error } => Some(error),
            RouteSectionKind::NotFound => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Slot {
    /// `None` is the default (nameless) slot.
    pub name: Option<Src>,
    pub args: Option<Vec<SlotArg>>,
    pub fallback: Option<Vec<Node>>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SlotArg {
    Expr(Src),
    Markup(Element),
}

#[derive(Debug, Clone, PartialEq)]
pub struct SlotFill {
    /// `None` fills the default slot.
    pub name: Option<Src>,
    /// The parameter list between the parentheses, verbatim TypeScript.
    pub params: Option<Src>,
    pub body: Vec<Node>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Case {
    /// `None` is `default`. Several labels share one body (`case 1: case 2:`).
    pub labels: Vec<Option<Src>>,
    pub body: Vec<Node>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Element {
    pub name: Src,
    pub attrs: Vec<Attr>,
    pub children: Vec<Node>,
}

impl Element {
    pub fn is_component(&self) -> bool {
        self.name.starts_with(|c: char| c.is_ascii_uppercase())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Attr {
    pub name: Src,
    pub value: AttrValue,
}

#[derive(Debug, Clone, PartialEq)]
pub enum AttrValue {
    Empty,
    Static(Src),
    Expr(Src),
    Interp(Vec<Part>),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Part {
    Text(String),
    Expr(Src),
}
