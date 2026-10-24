use std::path::Path;

#[test]
fn example_components_compile() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("examples/counter/pages");
    let app = std::fs::read_to_string(dir.join("Home.xzor")).unwrap();
    let ts = xzor::compile(&app, &dir.join("Home.xzor")).unwrap();
    assert!(ts.contains("import Counter from \"../Counter.xzor\";"));
    assert!(ts.contains("export default class Home extends ComponentBase {"));
    assert!(ts.contains("static readonly route = \"/\";"));
    assert!(ts.contains("__b.addComponent(Counter, { label: \"Fives\", step: 5 });"));
    assert!(app.contains("step=\"5\""));
    assert!(ts.contains("for (const step of this.steps) {"));
    assert!(ts.contains("__b.addContent(step);"));
}

#[test]
fn example_switch_compiles() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("examples/counter");
    let src = std::fs::read_to_string(dir.join("Counter.xzor")).unwrap();
    let ts = xzor::compile(&src, &dir.join("Counter.xzor")).unwrap();
    assert!(ts.contains("switch (this.count % 3) {"));
    assert!(ts.contains("case 1:\n          case 2: {"));
}

#[test]
fn parse_errors_have_positions() {
    let err = xzor::compile("<div>\n  <p>\n</div>", Path::new("Bad.xzor")).unwrap_err();
    assert_eq!((err.line, err.column), (3, 1));
    assert_eq!(err.message, "unexpected closing tag </div>");
}

#[test]
fn inject_constructor_error_points_at_the_constructor() {
    let err = xzor::compile("@inject A a\n@code {\n  n = 1;\n  constructor() { super(); }\n}\n<p/>", Path::new("C.xzor")).unwrap_err();
    assert_eq!((err.line, err.column), (4, 3));
    assert_eq!(err.message, "ZDI08: a component with @inject cannot declare a constructor");
}

#[test]
fn non_string_component_props_take_expressions() {
    let dir = std::env::temp_dir().join(format!("xzor-props-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let child = "@code {\n  label: string = \"x\";\n  step: number = 1;\n  mode: \"a\" | \"b\" = \"a\";\n  count = 0;\n  title = \"t\";\n  on?: () => void;\n}\n<p/>";
    std::fs::write(dir.join("Child.xzor"), child).unwrap();
    let app = "@import Child from \"./Child.xzor\"\n@code { n = 2; }\n<Child label=\"5\" step=\"5\" mode=\"b\" count=\"n + 1\" title=\"x\" on=\"() => n++\" />";
    let ts = xzor::compile(app, &dir.join("App.xzor")).unwrap();
    std::fs::remove_dir_all(&dir).unwrap();
    assert!(
        ts.contains(r#"__b.addComponent(Child, { label: "5", step: 5, mode: "b", count: this.n + 1, title: "x", on: () => this.n++ });"#),
        "{ts}"
    );
}
