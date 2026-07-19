//! LOA-73: the §3.6 global-search query language.

use loam_core::search::{QueryNode, SearchDoc, SearchIndex, compile_query, parse_query};
use tantivy::collector::TopDocs;
use tantivy::schema::Value;

fn term(text: &str) -> QueryNode {
    match parse_query(text).ast.expect("ast") {
        node @ QueryNode::Term { .. } => node,
        other => panic!("expected term, got {other:?}"),
    }
}

fn text_of(node: &QueryNode) -> &str {
    match node {
        QueryNode::Term { text, .. } | QueryNode::Phrase { text, .. } => text,
        other => panic!("expected leaf, got {other:?}"),
    }
}

/// AC1: precedence and grouping — implicit AND binds tighter than OR;
/// parentheses override.
#[test]
fn precedence_and_grouping_match_the_documented_examples() {
    // a b OR c  ==  (a AND b) OR c
    let ast = parse_query("alpha beta OR gamma").ast.expect("ast");
    let QueryNode::Or { nodes } = ast else {
        panic!("top is OR: {ast:?}")
    };
    assert_eq!(nodes.len(), 2);
    let QueryNode::And { nodes: left } = &nodes[0] else {
        panic!("left is AND: {:?}", nodes[0])
    };
    assert_eq!(
        left.iter().map(text_of).collect::<Vec<_>>(),
        ["alpha", "beta"]
    );
    assert_eq!(text_of(&nodes[1]), "gamma");

    // a OR b c  ==  a OR (b AND c)
    let ast = parse_query("alpha OR beta gamma").ast.expect("ast");
    let QueryNode::Or { nodes } = ast else {
        panic!("top is OR: {ast:?}")
    };
    assert_eq!(text_of(&nodes[0]), "alpha");
    assert!(matches!(&nodes[1], QueryNode::And { nodes } if nodes.len() == 2));

    // (a OR b) c  ==  grouping wins
    let ast = parse_query("(alpha OR beta) gamma").ast.expect("ast");
    let QueryNode::And { nodes } = ast else {
        panic!("top is AND: {ast:?}")
    };
    assert!(matches!(&nodes[0], QueryNode::Or { .. }));
    assert_eq!(text_of(&nodes[1]), "gamma");

    // Chained OR flattens left-to-right into one OR of three.
    let ast = parse_query("a OR b OR c").ast.expect("ast");
    assert!(matches!(&ast, QueryNode::Or { nodes } if nodes.len() == 3));

    // Single term stays a bare leaf with its span.
    let QueryNode::Term { span, .. } = term("solo") else {
        unreachable!()
    };
    assert_eq!((span.start, span.end), (0, 4));
}

/// AC2: quoted phrases preserve interior spaces and escapes.
#[test]
fn phrases_preserve_spaces_and_escapes() {
    let ast = parse_query("\"hello  spaced world\"").ast.expect("ast");
    assert_eq!(text_of(&ast), "hello  spaced world");

    let ast = parse_query(r#""say \"hi\" now""#).ast.expect("ast");
    assert_eq!(text_of(&ast), r#"say "hi" now"#);

    let ast = parse_query(r#""back\\slash""#).ast.expect("ast");
    assert_eq!(text_of(&ast), r"back\slash");

    // Unknown escapes pass through literally.
    let ast = parse_query(r#""a\qb""#).ast.expect("ast");
    assert_eq!(text_of(&ast), r"a\qb");

    // Phrase adjacent to terms participates in the AND.
    let ast = parse_query("intro \"exact phrase\" outro")
        .ast
        .expect("ast");
    let QueryNode::And { nodes } = ast else {
        panic!("AND: {ast:?}")
    };
    assert_eq!(nodes.len(), 3);
    assert_eq!(text_of(&nodes[1]), "exact phrase");
}

/// AC3: negation binds to the intended term or group.
#[test]
fn negation_applies_to_term_or_group() {
    let ast = parse_query("-alpha").ast.expect("ast");
    let QueryNode::Not { inner, span } = ast else {
        panic!("NOT: {ast:?}")
    };
    assert_eq!(text_of(&inner), "alpha");
    assert_eq!((span.start, span.end), (0, 6));

    // a -b: the negation only covers b.
    let ast = parse_query("alpha -beta").ast.expect("ast");
    let QueryNode::And { nodes } = ast else {
        panic!("AND: {ast:?}")
    };
    assert_eq!(text_of(&nodes[0]), "alpha");
    assert!(matches!(&nodes[1], QueryNode::Not { inner, .. } if text_of(inner) == "beta"));

    // -(a OR b): the group is negated as a whole.
    let ast = parse_query("-(alpha OR beta) gamma").ast.expect("ast");
    let QueryNode::And { nodes } = ast else {
        panic!("AND: {ast:?}")
    };
    assert!(
        matches!(&nodes[0], QueryNode::Not { inner, .. } if matches!(**inner, QueryNode::Or { .. }))
    );

    // Double negation nests.
    let ast = parse_query("--alpha").ast.expect("ast");
    assert!(
        matches!(&ast, QueryNode::Not { inner, .. } if matches!(**inner, QueryNode::Not { .. }))
    );
}

fn seeded_index() -> (tempfile::TempDir, SearchIndex) {
    let dir = tempfile::tempdir().expect("dir");
    let (mut search, _) = SearchIndex::open(dir.path()).expect("open");
    let docs = [
        SearchDoc {
            path: "notes/apple.md".into(),
            title: "Apple Pie".into(),
            headings: vec!["Baking".into()],
            body: "A recipe about baking apples with cinnamon.".into(),
            tags: vec!["cooking/desserts".into()],
            properties: vec!["status: draft".into()],
        },
        SearchDoc {
            path: "work/report.md".into(),
            title: "Quarterly Report".into(),
            headings: vec!["Revenue".into()],
            body: "Numbers went up. Apple stock too.".into(),
            tags: vec!["finance".into()],
            properties: vec!["status: final".into()],
        },
        SearchDoc {
            path: "notes/banana.md".into(),
            title: "Banana Bread".into(),
            headings: vec!["Baking".into()],
            body: "Ripe bananas make the best bread.".into(),
            tags: vec!["cooking/desserts".into()],
            properties: vec![],
        },
    ];
    for doc in &docs {
        search.upsert(doc).expect("upsert");
    }
    search.commit().expect("commit");
    (dir, search)
}

fn run(search: &SearchIndex, query: &str) -> Vec<String> {
    let parsed = parse_query(query);
    let compiled = compile_query(&parsed, search.tantivy()).expect("compiles");
    let reader = search.tantivy().reader().expect("reader");
    let searcher = reader.searcher();
    let schema = search.tantivy().schema();
    let path_field = schema.get_field("path").expect("path");
    let hits = searcher
        .search(&*compiled, &TopDocs::with_limit(10).order_by_score())
        .expect("search");
    let mut out: Vec<String> = hits
        .into_iter()
        .map(|(_, address)| {
            let doc: tantivy::TantivyDocument = searcher.doc(address).expect("doc");
            doc.get_first(path_field)
                .and_then(|v| v.as_str())
                .expect("path")
                .to_string()
        })
        .collect();
    out.sort();
    out
}

/// AC4: the P0 filters compile to the correct fields, and boosts hold.
#[test]
fn field_filters_compile_to_correct_fields() {
    let (_dir, search) = seeded_index();

    assert_eq!(
        run(&search, "tag:#cooking/desserts"),
        ["notes/apple.md", "notes/banana.md"],
        "tag filter hits the raw tags field, # optional"
    );
    assert_eq!(run(&search, "tag:finance"), ["work/report.md"]);
    assert_eq!(
        run(&search, "path:notes/"),
        ["notes/apple.md", "notes/banana.md"],
        "path filter is a prefix over the raw path"
    );
    assert_eq!(run(&search, "file:report"), ["work/report.md"]);
    assert_eq!(
        run(&search, "path:notes/ apple"),
        ["notes/apple.md"],
        "filters AND with terms"
    );
    assert_eq!(
        run(&search, "baking OR finance"),
        ["notes/apple.md", "notes/banana.md", "work/report.md"]
    );
    assert_eq!(
        run(&search, "banana -bread"),
        Vec::<String>::new(),
        "negation excludes"
    );
    assert_eq!(run(&search, "\"apple stock\""), ["work/report.md"]);

    // Boost check: "apple" appears in apple.md's TITLE and report.md's BODY —
    // the title hit must rank first.
    let parsed = parse_query("apple");
    let compiled = compile_query(&parsed, search.tantivy()).expect("compiles");
    let reader = search.tantivy().reader().expect("reader");
    let searcher = reader.searcher();
    let schema = search.tantivy().schema();
    let path_field = schema.get_field("path").expect("path");
    let ranked = searcher
        .search(&*compiled, &TopDocs::with_limit(10).order_by_score())
        .expect("search");
    let first: tantivy::TantivyDocument = searcher.doc(ranked[0].1).expect("doc");
    assert_eq!(
        first.get_first(path_field).and_then(|v| v.as_str()),
        Some("notes/apple.md"),
        "title boost outranks body"
    );
}

/// AC5: malformed and deferred syntax yields ranged diagnostics — and the
/// best-effort query still parses.
#[test]
fn malformed_and_deferred_syntax_yields_ranged_diagnostics() {
    let source = "\"never closed";
    let parsed = parse_query(source);
    assert_eq!(parsed.diagnostics[0].code, "unclosed-quote");
    assert_eq!(parsed.diagnostics[0].span.start, 0);
    assert_eq!(parsed.diagnostics[0].span.end, source.len());
    assert_eq!(text_of(&parsed.ast.expect("ast")), "never closed");

    let parsed = parse_query("(open group");
    assert!(
        parsed
            .diagnostics
            .iter()
            .any(|d| d.code == "unclosed-group"),
        "{:?}",
        parsed.diagnostics
    );
    assert!(parsed.ast.is_some(), "best-effort AST survives");

    let parsed = parse_query("stray )");
    assert!(
        parsed
            .diagnostics
            .iter()
            .any(|d| d.code == "unbalanced-paren")
    );

    let parsed = parse_query("alpha OR");
    assert!(parsed.diagnostics.iter().any(|d| d.code == "dangling-or"));
    assert_eq!(text_of(&parsed.ast.expect("ast")), "alpha");

    let parsed = parse_query("beta -");
    assert!(
        parsed
            .diagnostics
            .iter()
            .any(|d| d.code == "dangling-negation")
    );

    let parsed = parse_query("tag: alpha");
    assert!(parsed.diagnostics.iter().any(|d| d.code == "empty-filter"));

    // Deferred P1 operators: explicit unsupported diagnostics with spans.
    let source = "line:(10 20) alpha";
    let parsed = parse_query(source);
    let diagnostic = parsed
        .diagnostics
        .iter()
        .find(|d| d.code == "unsupported-operator")
        .expect("line: diagnosed");
    assert!(diagnostic.message.contains("line:"));
    assert!(diagnostic.span.end <= source.len());
    assert_eq!(
        text_of(&parsed.ast.expect("ast")),
        "alpha",
        "the deferred group does not leak terms"
    );

    let parsed = parse_query("[status:open] beta");
    let diagnostic = parsed
        .diagnostics
        .iter()
        .find(|d| d.code == "unsupported-operator")
        .expect("[property] diagnosed");
    assert_eq!((diagnostic.span.start, diagnostic.span.end), (0, 13));
    assert_eq!(text_of(&parsed.ast.expect("ast")), "beta");

    // Diagnostics serialize for the UI.
    let json = serde_json::to_value(parse_query("\"x")).expect("serializes");
    assert_eq!(json["diagnostics"][0]["code"], "unclosed-quote");

    // Empty and whitespace queries are calm.
    assert!(parse_query("").ast.is_none());
    assert!(parse_query("   ").ast.is_none());
}
