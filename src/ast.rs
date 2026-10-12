use std::fmt;
use std::ops::Deref;

/// Source text plus its byte offset in the `.tszor` file. Equality ignores the offset.
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
pub struct Document {
    pub page: Option<String>,
    /// `@typeparam` declarations, e.g. `T extends object`.
    pub type_params: Vec<Src>,
    /// `@inherits Base<T>`: the base class instead of `ComponentBase`.
    pub inherits: Option<Src>,
    /// `@implements A, B`.
    pub implements: Vec<Src>,
    /// `@attribute dec(args)`: class decorators.
    pub attributes: Vec<Src>,
    /// What follows `@import`, without a trailing `;`.
    pub imports: Vec<Src>,
    /// Raw bodies of `@code { ... }` blocks; they become class members.
    pub code: Vec<Src>,
    /// The same blocks split into TypeScript and markup used as values (`RenderFragment`s).
    pub code_parts: Vec<Vec<CodePart>>,
    pub nodes: Vec<Node>,
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
        body: Vec<Node>,
    },
    While {
        cond: Src,
        body: Vec<Node>,
    },
    /// `@{ statements }` inside the template.
    Code(Vec<CodePart>),
    Switch {
        subject: Src,
        cases: Vec<Case>,
    },
    /// `@slot`, `@slot:name(args) { fallback }` in a component's own template.
    Slot(Slot),
    /// `@slot name(params) { body }` as a direct child of a component tag.
    SlotFill(SlotFill),
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
