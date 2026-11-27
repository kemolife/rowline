//! Converting Postgres values to JSON for the grid, and JSON back to text parameters.
//! Every value is read in text format (exactly as the server prints it) and converted by type:
//! small ints and floats become JSON numbers, int8 only when exact in JavaScript, bool becomes a JSON
//! bool, bytea is cut, everything else (numeric, timestamps, json, arrays, unknown types) stays text.

use serde_json::Value;
use tokio_postgres::types::{Kind, Type};

/// Same limit as MySQL / SQLite blobs (`blob_preview`): 256 bytes = 512 hex digits.
const BYTEA_PREVIEW_HEX: usize = 512;
const MAX_SAFE_INT: u64 = 1 << 53;

pub(super) fn text_to_json(ty: &Type, text: Option<&str>) -> Value {
    let Some(text) = text else { return Value::Null };
    let string = || Value::String(text.to_string());
    match *ty {
        Type::INT2 | Type::INT4 | Type::OID => text.parse::<i64>().map(Value::from).unwrap_or_else(|_| string()),
        // bigint beyond 2^53 would lose precision in JavaScript
        Type::INT8 => match text.parse::<i64>() {
            Ok(n) if n.unsigned_abs() <= MAX_SAFE_INT => Value::from(n),
            _ => string(),
        },
        // NaN / Infinity have no JSON number: they stay text
        Type::FLOAT4 | Type::FLOAT8 => text
            .parse::<f64>()
            .ok()
            .filter(|f| f.is_finite())
            .and_then(serde_json::Number::from_f64)
            .map(Value::Number)
            .unwrap_or_else(string),
        Type::BOOL => match text {
            "t" => Value::Bool(true),
            "f" => Value::Bool(false),
            _ => string(),
        },
        Type::BYTEA => Value::String(bytea_preview(text)),
        _ => string(),
    }
}

/// `\x…` hex text cut to the blob preview length.
fn bytea_preview(text: &str) -> String {
    let Some(hex) = text.strip_prefix("\\x") else { return text.chars().take(BYTEA_PREVIEW_HEX).collect() };
    if hex.len() > BYTEA_PREVIEW_HEX {
        format!("\\x{}…", &hex[..BYTEA_PREVIEW_HEX])
    } else {
        text.to_string()
    }
}

/// Column type for the grid header: the Postgres name (`int4`, `numeric`, `timestamptz`), arrays as `text[]`.
pub(super) fn type_name(ty: &Type) -> String {
    match ty.kind() {
        Kind::Array(inner) => format!("{}[]", inner.name()),
        _ => ty.name().to_string(),
    }
}

/// Grid values go to the server as text and are cast there with `$n::type`.
pub(super) fn json_to_text(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => Some(n.to_string()),
        other => Some(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_stay_exact() {
        assert_eq!(text_to_json(&Type::INT4, Some("42")), json!(42));
        assert_eq!(text_to_json(&Type::INT2, Some("-7")), json!(-7));
        assert_eq!(text_to_json(&Type::INT8, Some("9007199254740992")), json!(9007199254740992u64));
        assert_eq!(text_to_json(&Type::INT8, Some("9007199254740993")), json!("9007199254740993"));
        assert_eq!(text_to_json(&Type::INT8, Some("-9007199254740993")), json!("-9007199254740993"));
        assert_eq!(text_to_json(&Type::NUMERIC, Some("12345678901234567890.12")), json!("12345678901234567890.12"));
        assert_eq!(text_to_json(&Type::FLOAT8, Some("1.5")), json!(1.5));
        assert_eq!(text_to_json(&Type::FLOAT8, Some("NaN")), json!("NaN"));
        assert_eq!(text_to_json(&Type::FLOAT4, Some("Infinity")), json!("Infinity"));
    }

    #[test]
    fn other_types_keep_the_server_text() {
        assert_eq!(text_to_json(&Type::BOOL, Some("t")), json!(true));
        assert_eq!(text_to_json(&Type::BOOL, Some("f")), json!(false));
        assert_eq!(text_to_json(&Type::JSONB, Some("{\"a\": 1}")), json!("{\"a\": 1}"));
        assert_eq!(text_to_json(&Type::TIMESTAMPTZ, Some("2024-01-02 03:04:05+01")), json!("2024-01-02 03:04:05+01"));
        assert_eq!(text_to_json(&Type::TEXT_ARRAY, Some("{a,b}")), json!("{a,b}"));
        assert_eq!(text_to_json(&Type::UUID, None), Value::Null);
    }

    #[test]
    fn bytea_is_cut_like_blobs() {
        assert_eq!(text_to_json(&Type::BYTEA, Some("\\xcafe")), json!("\\xcafe"));
        let long = format!("\\x{}", "ab".repeat(300));
        let shown = text_to_json(&Type::BYTEA, Some(&long));
        assert_eq!(shown, json!(format!("\\x{}…", "ab".repeat(256))));
    }

    #[test]
    fn type_names() {
        assert_eq!(type_name(&Type::INT4), "int4");
        assert_eq!(type_name(&Type::TEXT_ARRAY), "text[]");
    }

    #[test]
    fn json_values_become_text() {
        assert_eq!(json_to_text(&json!(null)), None);
        assert_eq!(json_to_text(&json!("x")), Some("x".into()));
        assert_eq!(json_to_text(&json!(1.5)), Some("1.5".into()));
        assert_eq!(json_to_text(&json!(true)), Some("true".into()));
        assert_eq!(json_to_text(&json!({"a": 1})), Some("{\"a\":1}".into()));
    }
}
