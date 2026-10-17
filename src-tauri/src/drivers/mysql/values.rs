//! Converting MySQL values to JSON for the grid, and JSON back to MySQL parameters.

use crate::drivers::sqlite::blob_preview;
use mysql_async::consts::{ColumnFlags, ColumnType};
use mysql_async::{Column, Value as MyValue};
use serde_json::Value;

pub(super) const BINARY_CHARSET: u16 = 63;

pub(super) fn is_binary(col: &Column) -> bool {
    col.character_set() == BINARY_CHARSET
        && matches!(
            col.column_type(),
            ColumnType::MYSQL_TYPE_BLOB
                | ColumnType::MYSQL_TYPE_TINY_BLOB
                | ColumnType::MYSQL_TYPE_MEDIUM_BLOB
                | ColumnType::MYSQL_TYPE_LONG_BLOB
                | ColumnType::MYSQL_TYPE_STRING
                | ColumnType::MYSQL_TYPE_VAR_STRING
                | ColumnType::MYSQL_TYPE_VARCHAR
                | ColumnType::MYSQL_TYPE_GEOMETRY
                | ColumnType::MYSQL_TYPE_BIT
        )
}

pub(super) fn type_name(col: &Column) -> String {
    use ColumnType::*;
    let unsigned = col.flags().contains(ColumnFlags::UNSIGNED_FLAG);
    let base = match col.column_type() {
        MYSQL_TYPE_TINY => "tinyint",
        MYSQL_TYPE_SHORT => "smallint",
        MYSQL_TYPE_INT24 => "mediumint",
        MYSQL_TYPE_LONG => "int",
        MYSQL_TYPE_LONGLONG => "bigint",
        MYSQL_TYPE_FLOAT => "float",
        MYSQL_TYPE_DOUBLE => "double",
        MYSQL_TYPE_DECIMAL | MYSQL_TYPE_NEWDECIMAL => "decimal",
        MYSQL_TYPE_DATE | MYSQL_TYPE_NEWDATE => "date",
        MYSQL_TYPE_DATETIME | MYSQL_TYPE_DATETIME2 => "datetime",
        MYSQL_TYPE_TIMESTAMP | MYSQL_TYPE_TIMESTAMP2 => "timestamp",
        MYSQL_TYPE_TIME | MYSQL_TYPE_TIME2 => "time",
        MYSQL_TYPE_YEAR => "year",
        MYSQL_TYPE_JSON => "json",
        MYSQL_TYPE_BIT => "bit",
        MYSQL_TYPE_GEOMETRY => "geometry",
        MYSQL_TYPE_ENUM => "enum",
        MYSQL_TYPE_SET => "set",
        MYSQL_TYPE_BLOB | MYSQL_TYPE_TINY_BLOB | MYSQL_TYPE_MEDIUM_BLOB | MYSQL_TYPE_LONG_BLOB => {
            if is_binary(col) { "blob" } else { "text" }
        }
        MYSQL_TYPE_STRING => {
            if col.flags().contains(ColumnFlags::ENUM_FLAG) {
                "enum"
            } else if col.flags().contains(ColumnFlags::SET_FLAG) {
                "set"
            } else if is_binary(col) {
                "binary"
            } else {
                "char"
            }
        }
        MYSQL_TYPE_VAR_STRING | MYSQL_TYPE_VARCHAR => {
            if is_binary(col) { "varbinary" } else { "varchar" }
        }
        _ => "unknown",
    };
    if unsigned && !matches!(base, "decimal" | "float" | "double") {
        format!("{base} unsigned")
    } else {
        base.to_string()
    }
}

/// Text protocol delivers values as bytes; numbers become JSON numbers only when exact.
pub(super) fn mysql_to_json(v: &MyValue, col: &Column) -> Value {
    use ColumnType::*;
    match v {
        MyValue::NULL => Value::Null,
        MyValue::Int(i) => Value::from(*i),
        MyValue::UInt(u) => Value::from(*u),
        MyValue::Float(f) => serde_json::Number::from_f64(*f as f64).map(Value::Number).unwrap_or(Value::Null),
        MyValue::Double(f) => serde_json::Number::from_f64(*f).map(Value::Number).unwrap_or(Value::Null),
        MyValue::Bytes(b) => {
            if is_binary(col) {
                return Value::String(blob_preview(b));
            }
            let text = String::from_utf8_lossy(b).to_string();
            match col.column_type() {
                MYSQL_TYPE_TINY | MYSQL_TYPE_SHORT | MYSQL_TYPE_INT24 | MYSQL_TYPE_LONG | MYSQL_TYPE_YEAR => {
                    text.parse::<i64>().map(Value::from).unwrap_or(Value::String(text))
                }
                // bigint beyond 2^53 would lose precision in JavaScript
                MYSQL_TYPE_LONGLONG => match text.parse::<i64>() {
                    Ok(n) if n.unsigned_abs() <= (1u64 << 53) => Value::from(n),
                    _ => Value::String(text),
                },
                MYSQL_TYPE_FLOAT | MYSQL_TYPE_DOUBLE => text
                    .parse::<f64>()
                    .ok()
                    .and_then(serde_json::Number::from_f64)
                    .map(Value::Number)
                    .unwrap_or(Value::String(text)),
                _ => Value::String(text),
            }
        }
        other => Value::String(other.as_sql(true).trim_matches('\'').to_string()),
    }
}

pub(super) fn json_to_mysql(v: &Value) -> MyValue {
    match v {
        Value::Null => MyValue::NULL,
        Value::Bool(b) => MyValue::Int(*b as i64),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                MyValue::Int(i)
            } else if let Some(u) = n.as_u64() {
                MyValue::UInt(u)
            } else {
                MyValue::Double(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(s) => MyValue::Bytes(s.clone().into_bytes()),
        other => MyValue::Bytes(other.to_string().into_bytes()),
    }
}