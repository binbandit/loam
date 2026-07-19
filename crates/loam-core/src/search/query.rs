//! The §3.6 global-search query language (LOA-73): terms, quoted phrases,
//! unary `-` negation, `OR`, parentheses, and the P0 field filters `tag:`,
//! `path:`, `file:`. Parsing never fails — malformed or deferred (P1) syntax
//! yields ranged diagnostics and the best-effort remainder, so meaning is
//! never silently changed.
//!
//! Grammar (implicit AND binds tighter than OR; `-` binds tightest):
//! `query := and (OR and)*` · `and := unary+` · `unary := '-' unary | prim`
//! `prim := '(' query ')' | filter | phrase | term`

use serde::Serialize;

use tantivy::query::{AllQuery, BooleanQuery, BoostQuery, Occur, Query, RegexQuery, TermQuery};
use tantivy::schema::IndexRecordOption;
use tantivy::{Index, Term};

use super::schema::{
    BODY_BOOST, FIELD_BODY, FIELD_HEADINGS, FIELD_PATH, FIELD_PATH_TEXT, FIELD_TAGS,
    FIELD_TAGS_RAW, FIELD_TITLE, HEADINGS_BOOST, TAGS_BOOST, TITLE_BOOST,
};

/// Byte span into the original query string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuerySpan {
    pub start: usize,
    pub end: usize,
}

/// P0 field filters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FilterField {
    Tag,
    Path,
    File,
}

/// Serializable query AST with spans for UI highlighting.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "node")]
pub enum QueryNode {
    Term {
        text: String,
        span: QuerySpan,
    },
    Phrase {
        text: String,
        span: QuerySpan,
    },
    Filter {
        field: FilterField,
        value: String,
        span: QuerySpan,
    },
    Not {
        inner: Box<QueryNode>,
        span: QuerySpan,
    },
    And {
        nodes: Vec<QueryNode>,
    },
    Or {
        nodes: Vec<QueryNode>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryDiagnostic {
    /// Stable machine code, e.g. `unclosed-quote`, `unsupported-operator`.
    pub code: String,
    pub message: String,
    pub span: QuerySpan,
}

/// Parse output: best-effort AST (None for an effectively empty query) plus
/// diagnostics. Serializable end to end.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedQuery {
    pub ast: Option<QueryNode>,
    pub diagnostics: Vec<QueryDiagnostic>,
}

// ─── Tokenizer ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Word(String),
    Phrase(String),
    Filter(FilterField, String),
    Neg,
    Or,
    Open,
    Close,
}

struct Spanned {
    token: Token,
    span: QuerySpan,
}

fn span(start: usize, end: usize) -> QuerySpan {
    QuerySpan { start, end }
}

struct Tokenizer<'s> {
    source: &'s str,
    at: usize,
    diagnostics: Vec<QueryDiagnostic>,
}

impl<'s> Tokenizer<'s> {
    fn rest(&self) -> &'s str {
        &self.source[self.at..]
    }

    /// Read a quoted phrase body starting AFTER the opening quote.
    /// Supports `\"` and `\\` escapes; preserves interior spaces.
    fn phrase(&mut self, open: usize) -> Spanned {
        let mut text = String::new();
        let mut chars = self.rest().char_indices();
        let mut closed = false;
        let mut consumed = 0;
        while let Some((offset, c)) = chars.next() {
            consumed = offset + c.len_utf8();
            match c {
                '\\' => match chars.next() {
                    Some((next_offset, escaped @ ('"' | '\\'))) => {
                        consumed = next_offset + escaped.len_utf8();
                        text.push(escaped);
                    }
                    Some((next_offset, other)) => {
                        consumed = next_offset + other.len_utf8();
                        text.push('\\');
                        text.push(other);
                    }
                    None => text.push('\\'),
                },
                '"' => {
                    closed = true;
                    break;
                }
                other => text.push(other),
            }
        }
        self.at += consumed;
        if !closed {
            self.at = self.source.len();
            self.diagnostics.push(QueryDiagnostic {
                code: "unclosed-quote".into(),
                message: "`\"` has no closing quote; the rest is treated as the phrase".into(),
                span: span(open, self.source.len()),
            });
        }
        Spanned {
            token: Token::Phrase(text),
            span: span(open, self.at),
        }
    }

    fn word_or_filter(&mut self, start: usize) -> Spanned {
        let rest = self.rest();
        let end_offset = rest
            .char_indices()
            .find(|(_, c)| c.is_whitespace() || matches!(c, '(' | ')' | '"'))
            .map(|(i, _)| i)
            .unwrap_or(rest.len());
        let word = &rest[..end_offset];
        self.at += end_offset;
        let token_span = span(start, self.at);

        let filter = |field, value: &str| Spanned {
            token: Token::Filter(field, value.to_string()),
            span: token_span,
        };
        if let Some(value) = word.strip_prefix("tag:") {
            let value = value.strip_prefix('#').unwrap_or(value);
            return filter(FilterField::Tag, value);
        }
        if let Some(value) = word.strip_prefix("path:") {
            return filter(FilterField::Path, value);
        }
        if let Some(value) = word.strip_prefix("file:") {
            return filter(FilterField::File, value);
        }
        if word.starts_with("line:") {
            self.diagnostics.push(QueryDiagnostic {
                code: "unsupported-operator".into(),
                message: "`line:(a b)` search is not supported yet (P1)".into(),
                span: token_span,
            });
            // Consume a following parenthesized group so it does not leak
            // into the query as terms.
            if word == "line:" || word.ends_with("line:") {
                self.skip_group();
            }
            return Spanned {
                token: Token::Word(String::new()),
                span: token_span,
            };
        }
        if word == "OR" {
            return Spanned {
                token: Token::Or,
                span: token_span,
            };
        }
        Spanned {
            token: Token::Word(word.to_string()),
            span: token_span,
        }
    }

    fn skip_group(&mut self) {
        let rest = self.rest();
        if rest.starts_with('(') {
            let close = rest.find(')').map(|i| i + 1).unwrap_or(rest.len());
            self.at += close;
        }
    }

    fn tokenize(mut self) -> (Vec<Spanned>, Vec<QueryDiagnostic>) {
        let mut tokens = Vec::new();
        while self.at < self.source.len() {
            let rest = self.rest();
            let c = rest.chars().next().expect("non-empty");
            let start = self.at;
            match c {
                _ if c.is_whitespace() => self.at += c.len_utf8(),
                '"' => {
                    self.at += 1;
                    tokens.push(self.phrase(start));
                }
                '(' => {
                    self.at += 1;
                    tokens.push(Spanned {
                        token: Token::Open,
                        span: span(start, self.at),
                    });
                }
                ')' => {
                    self.at += 1;
                    tokens.push(Spanned {
                        token: Token::Close,
                        span: span(start, self.at),
                    });
                }
                '-' => {
                    self.at += 1;
                    tokens.push(Spanned {
                        token: Token::Neg,
                        span: span(start, self.at),
                    });
                }
                '[' => {
                    // `[property:value]` is P1: consume the group, diagnose.
                    let close = rest.find(']').map(|i| i + 1).unwrap_or(rest.len());
                    self.at += close;
                    self.diagnostics.push(QueryDiagnostic {
                        code: "unsupported-operator".into(),
                        message: "`[property:value]` search is not supported yet (P1)".into(),
                        span: span(start, self.at),
                    });
                }
                _ => {
                    let spanned = self.word_or_filter(start);
                    if !matches!(&spanned.token, Token::Word(w) if w.is_empty()) {
                        tokens.push(spanned);
                    }
                }
            }
        }
        (tokens, self.diagnostics)
    }
}

// ─── Parser ─────────────────────────────────────────────────────────────────

struct Parser {
    tokens: Vec<Spanned>,
    at: usize,
    diagnostics: Vec<QueryDiagnostic>,
}

impl Parser {
    fn peek(&self) -> Option<&Spanned> {
        self.tokens.get(self.at)
    }

    fn or_expr(&mut self) -> Option<QueryNode> {
        let mut branches = Vec::new();
        if let Some(first) = self.and_expr() {
            branches.push(first);
        }
        while let Some(spanned) = self.peek() {
            if !matches!(spanned.token, Token::Or) {
                break;
            }
            let or_span = spanned.span;
            self.at += 1;
            match self.and_expr() {
                Some(branch) => branches.push(branch),
                None => self.diagnostics.push(QueryDiagnostic {
                    code: "dangling-or".into(),
                    message: "`OR` has no right-hand side".into(),
                    span: or_span,
                }),
            }
        }
        match branches.len() {
            0 => None,
            1 => branches.pop(),
            _ => Some(QueryNode::Or { nodes: branches }),
        }
    }

    fn and_expr(&mut self) -> Option<QueryNode> {
        let mut nodes = Vec::new();
        while let Some(spanned) = self.peek() {
            match spanned.token {
                Token::Or | Token::Close => break,
                _ => match self.unary() {
                    Some(node) => nodes.push(node),
                    None => break,
                },
            }
        }
        match nodes.len() {
            0 => None,
            1 => nodes.pop(),
            _ => Some(QueryNode::And { nodes }),
        }
    }

    fn unary(&mut self) -> Option<QueryNode> {
        let spanned = self.peek()?;
        if matches!(spanned.token, Token::Neg) {
            let neg_span = spanned.span;
            self.at += 1;
            return match self.unary() {
                Some(inner) => {
                    let end = node_end(&inner).unwrap_or(neg_span.end);
                    Some(QueryNode::Not {
                        inner: Box::new(inner),
                        span: span(neg_span.start, end),
                    })
                }
                None => {
                    self.diagnostics.push(QueryDiagnostic {
                        code: "dangling-negation".into(),
                        message: "`-` has nothing to negate".into(),
                        span: neg_span,
                    });
                    None
                }
            };
        }
        self.primary()
    }

    fn primary(&mut self) -> Option<QueryNode> {
        let spanned = self.peek()?;
        let token_span = spanned.span;
        match spanned.token.clone() {
            Token::Open => {
                self.at += 1;
                let inner = self.or_expr();
                match self.peek() {
                    Some(next) if matches!(next.token, Token::Close) => self.at += 1,
                    _ => self.diagnostics.push(QueryDiagnostic {
                        code: "unclosed-group".into(),
                        message: "`(` has no matching `)`".into(),
                        span: token_span,
                    }),
                }
                if inner.is_none() {
                    self.diagnostics.push(QueryDiagnostic {
                        code: "empty-group".into(),
                        message: "empty `()` group".into(),
                        span: token_span,
                    });
                }
                inner
            }
            Token::Close => {
                self.at += 1;
                self.diagnostics.push(QueryDiagnostic {
                    code: "unbalanced-paren".into(),
                    message: "`)` without a matching `(`".into(),
                    span: token_span,
                });
                self.primary()
            }
            Token::Word(text) => {
                self.at += 1;
                Some(QueryNode::Term {
                    text,
                    span: token_span,
                })
            }
            Token::Phrase(text) => {
                self.at += 1;
                Some(QueryNode::Phrase {
                    text,
                    span: token_span,
                })
            }
            Token::Filter(field, value) => {
                self.at += 1;
                if value.is_empty() {
                    self.diagnostics.push(QueryDiagnostic {
                        code: "empty-filter".into(),
                        message: "field filter has no value".into(),
                        span: token_span,
                    });
                    return self.primary();
                }
                Some(QueryNode::Filter {
                    field,
                    value,
                    span: token_span,
                })
            }
            Token::Neg | Token::Or => None, // handled by callers
        }
    }
}

fn node_end(node: &QueryNode) -> Option<usize> {
    match node {
        QueryNode::Term { span, .. }
        | QueryNode::Phrase { span, .. }
        | QueryNode::Filter { span, .. }
        | QueryNode::Not { span, .. } => Some(span.end),
        QueryNode::And { nodes } | QueryNode::Or { nodes } => nodes.last().and_then(node_end),
    }
}

/// Parse a raw §3.6 search string. Total: always returns, never panics.
pub fn parse_query(source: &str) -> ParsedQuery {
    let (tokens, mut diagnostics) = Tokenizer {
        source,
        at: 0,
        diagnostics: Vec::new(),
    }
    .tokenize();
    let mut parser = Parser {
        tokens,
        at: 0,
        diagnostics: Vec::new(),
    };
    let mut ast = parser.or_expr();
    // Anything left over (stray closers) — drain with diagnostics.
    while parser.peek().is_some() {
        if parser.primary().is_none() {
            parser.at += 1;
        }
    }
    diagnostics.append(&mut parser.diagnostics);
    if let Some(QueryNode::Not { .. }) = &ast {
        // A pure negation matches "everything except" — valid; keep as-is.
    }
    if matches!(&ast, Some(QueryNode::And { nodes }) if nodes.is_empty()) {
        ast = None;
    }
    ParsedQuery { ast, diagnostics }
}

// ─── Compilation to tantivy ─────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum CompileError {
    #[error("query field missing from the search schema: {0}")]
    MissingField(String),
    #[error("invalid filter value: {0}")]
    InvalidFilter(String),
}

struct CompileFields {
    title: tantivy::schema::Field,
    headings: tantivy::schema::Field,
    body: tantivy::schema::Field,
    tags: tantivy::schema::Field,
    tags_raw: tantivy::schema::Field,
    path: tantivy::schema::Field,
    path_text: tantivy::schema::Field,
}

fn boosted_fields(fields: &CompileFields) -> [(tantivy::schema::Field, f32); 4] {
    [
        (fields.title, TITLE_BOOST),
        (fields.headings, HEADINGS_BOOST),
        (fields.body, BODY_BOOST),
        (fields.tags, TAGS_BOOST),
    ]
}

/// Tokenize free text the way the TEXT fields were indexed (lowercased,
/// split on non-alphanumerics).
fn tokens_of(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
}

fn compile_node(node: &QueryNode, fields: &CompileFields) -> Result<Box<dyn Query>, CompileError> {
    match node {
        QueryNode::Term { text, .. } | QueryNode::Phrase { text, .. } => {
            let tokens = tokens_of(text);
            if tokens.is_empty() {
                return Ok(Box::new(AllQuery));
            }
            let mut branches: Vec<(Occur, Box<dyn Query>)> = Vec::new();
            for (field, boost) in boosted_fields(fields) {
                let query: Box<dyn Query> = if tokens.len() == 1 {
                    Box::new(TermQuery::new(
                        Term::from_field_text(field, &tokens[0]),
                        IndexRecordOption::WithFreqsAndPositions,
                    ))
                } else {
                    let terms: Vec<Term> = tokens
                        .iter()
                        .map(|t| Term::from_field_text(field, t))
                        .collect();
                    Box::new(tantivy::query::PhraseQuery::new(terms))
                };
                branches.push((Occur::Should, Box::new(BoostQuery::new(query, boost))));
            }
            Ok(Box::new(BooleanQuery::new(branches)))
        }
        QueryNode::Filter { field, value, .. } => match field {
            FilterField::Tag => Ok(Box::new(TermQuery::new(
                Term::from_field_text(fields.tags_raw, value),
                IndexRecordOption::Basic,
            ))),
            FilterField::Path => {
                let pattern = format!("{}.*", regex_escape(value));
                RegexQuery::from_pattern(&pattern, fields.path)
                    .map(|q| Box::new(q) as Box<dyn Query>)
                    .map_err(|e| CompileError::InvalidFilter(e.to_string()))
            }
            FilterField::File => {
                let tokens = tokens_of(value);
                let branches: Vec<(Occur, Box<dyn Query>)> = tokens
                    .iter()
                    .map(|t| {
                        (
                            Occur::Must,
                            Box::new(TermQuery::new(
                                Term::from_field_text(fields.path_text, t),
                                IndexRecordOption::Basic,
                            )) as Box<dyn Query>,
                        )
                    })
                    .collect();
                Ok(Box::new(BooleanQuery::new(branches)))
            }
        },
        QueryNode::Not { inner, .. } => {
            let inner = compile_node(inner, fields)?;
            Ok(Box::new(BooleanQuery::new(vec![
                (Occur::Must, Box::new(AllQuery) as Box<dyn Query>),
                (Occur::MustNot, inner),
            ])))
        }
        QueryNode::And { nodes } => {
            let mut branches: Vec<(Occur, Box<dyn Query>)> = Vec::new();
            for child in nodes {
                match child {
                    // Negations inside an AND become MustNot legs directly.
                    QueryNode::Not { inner, .. } => {
                        branches.push((Occur::MustNot, compile_node(inner, fields)?))
                    }
                    positive => branches.push((Occur::Must, compile_node(positive, fields)?)),
                }
            }
            if branches.iter().all(|(occur, _)| *occur == Occur::MustNot) {
                branches.push((Occur::Must, Box::new(AllQuery)));
            }
            Ok(Box::new(BooleanQuery::new(branches)))
        }
        QueryNode::Or { nodes } => {
            let mut branches: Vec<(Occur, Box<dyn Query>)> = Vec::new();
            for child in nodes {
                branches.push((Occur::Should, compile_node(child, fields)?));
            }
            Ok(Box::new(BooleanQuery::new(branches)))
        }
    }
}

fn regex_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        if "\\.+*?()|[]{}^$#&-~\"".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Compile a parsed query against a search index's schema. `None` AST (empty
/// query) compiles to match-all — callers decide whether to run it.
pub fn compile_query(parsed: &ParsedQuery, index: &Index) -> Result<Box<dyn Query>, CompileError> {
    let schema = index.schema();
    let field = |name: &str| {
        schema
            .get_field(name)
            .map_err(|_| CompileError::MissingField(name.to_string()))
    };
    let fields = CompileFields {
        title: field(FIELD_TITLE)?,
        headings: field(FIELD_HEADINGS)?,
        body: field(FIELD_BODY)?,
        tags: field(FIELD_TAGS)?,
        tags_raw: field(FIELD_TAGS_RAW)?,
        path: field(FIELD_PATH)?,
        path_text: field(FIELD_PATH_TEXT)?,
    };
    match &parsed.ast {
        Some(node) => compile_node(node, &fields),
        None => Ok(Box::new(AllQuery)),
    }
}
