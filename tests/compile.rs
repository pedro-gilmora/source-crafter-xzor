use std::path::Path;

#[test]
fn example_components_compile() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("examples/counter");
    let app = std::fs::read_to_string(dir.join("App.tszor")).unwrap();
    let ts = zor::compile(&app, &dir.join("App.tszor")).unwrap();
    assert!(ts.contains("import Counter from \"./Counter.tszor\";"));
    assert!(ts.contains("export default class App extends ComponentBase {"));
    assert!(ts.contains("static readonly route = \"/\";"));
    assert!(ts.contains("__b.addComponent(Counter, { label: \"Fives\", step: 5 });"));
    assert!(app.contains("step=\"5\""));
    assert!(ts.contains("for (const step of this.steps) {"));
    assert!(ts.contains("__b.addContent(step);"));
}

#[test]
fn example_switch_compiles() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("examples/counter");
    let src = std::fs::read_to_string(dir.join("Counter.tszor")).unwrap();
    let ts = zor::compile(&src, &dir.join("Counter.tszor")).unwrap();
    assert!(ts.contains("switch (this.count % 3) {"));
    assert!(ts.contains("case 1:\n      case 2: {"));
}

#[test]
fn parse_errors_have_positions() {
    let err = zor::compile("<div>\n  <p>\n</div>", Path::new("Bad.tszor")).unwrap_err();
    assert_eq!((err.line, err.column), (3, 1));
    assert_eq!(err.message, "unexpected closing tag </div>");
}

#[test]
fn non_string_component_props_take_expressions() {
    let dir = std::env::temp_dir().join(format!("zor-props-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let child = "@code {\n  label: string = \"x\";\n  step: number = 1;\n  mode: \"a\" | \"b\" = \"a\";\n  count = 0;\n  title = \"t\";\n  on?: () => void;\n}\n<p/>";
    std::fs::write(dir.join("Child.tszor"), child).unwrap();
    let app = "@import Child from \"./Child.tszor\"\n@code { n = 2; }\n<Child label=\"5\" step=\"5\" mode=\"b\" count=\"n + 1\" title=\"x\" on=\"() => n++\" />";
    let ts = zor::compile(app, &dir.join("App.tszor")).unwrap();
    std::fs::remove_dir_all(&dir).unwrap();
    assert!(
        ts.contains(r#"__b.addComponent(Child, { label: "5", step: 5, mode: "b", count: this.n + 1, title: "x", on: () => this.n++ });"#),
        "{ts}"
    );
}
