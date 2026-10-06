//! Filtered queries over JSON values (`POST /v1/query`, D-030).
//!
//! A filter is a JSON document in a MongoDB-like syntax, parsed once into a
//! [`Filter`] and evaluated next to the data: on this node in single-node
//! mode, and on a replica of every replication group in a cluster. Scans
//! stop after `max_scanned` rows, so a selective filter returns a short page
//! plus a cursor instead of reading the whole range in one request.

use std::cmp::Ordering;
use std::ops::Bound;

use celeris_storage::{Engine, Record};
use serde_json::{Map, Value};

/// Most nodes (conditions and operators) one filter may have.
const MAX_FILTER_NODES: usize = 256;
/// Deepest nesting of `$and` / `$or` / `$not`.
const MAX_FILTER_DEPTH: usize = 16;
/// Longest `$in` / `$nin` list.
const MAX_IN_VALUES: usize = 1000;

/// Rows read per storage scan call while filtering.
const SCAN_CHUNK: usize = 256;

#[derive(Debug, Clone, PartialEq)]
pub enum Filter {
    And(Vec<Filter>),
    Or(Vec<Filter>),
    Not(Box<Filter>),
    Field { path: Vec<String>, op: Op },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    Eq(Value),
    Ne(Value),
    Gt(Value),
    Gte(Value),
    Lt(Value),
    Lte(Value),
    In(Vec<Value>),
    Nin(Vec<Value>),
    Exists(bool),
    Prefix(String),
    Contains(Value),
}

impl Filter {
    /// Parses a filter document. Errors are messages for the client.
    pub fn parse(doc: &Value) -> Result<Filter, String> {
        let mut nodes = 0;
        parse_doc(doc, 0, &mut nodes)
    }

    pub fn matches(&self, value: &Value) -> bool {
        match self {
            Filter::And(all) => all.iter().all(|f| f.matches(value)),
            Filter::Or(any) => any.iter().any(|f| f.matches(value)),
            Filter::Not(f) => !f.matches(value),
            Filter::Field { path, op } => op.matches(lookup(value, path)),
        }
    }
}

fn count(nodes: &mut usize) -> Result<(), String> {
    *nodes += 1;
    if *nodes > MAX_FILTER_NODES {
        return Err(format!(
            "the filter has more than {MAX_FILTER_NODES} conditions"
        ));
    }
    Ok(())
}

fn parse_doc(doc: &Value, depth: usize, nodes: &mut usize) -> Result<Filter, String> {
    if depth > MAX_FILTER_DEPTH {
        return Err(format!(
            "the filter is nested deeper than {MAX_FILTER_DEPTH} levels"
        ));
    }
    let Value::Object(fields) = doc else {
        return Err("a filter must be a JSON object".into());
    };
    let mut all = Vec::with_capacity(fields.len());
    for (name, cond) in fields {
        count(nodes)?;
        match name.as_str() {
            "$and" | "$or" => {
                let Value::Array(items) = cond else {
                    return Err(format!("{name} takes an array of filters"));
                };
                if items.is_empty() {
                    return Err(format!("{name} needs at least one filter"));
                }
                let parts = items
                    .iter()
                    .map(|f| parse_doc(f, depth + 1, nodes))
                    .collect::<Result<Vec<_>, _>>()?;
                all.push(if name == "$and" {
                    Filter::And(parts)
                } else {
                    Filter::Or(parts)
                });
            }
            "$not" => all.push(Filter::Not(Box::new(parse_doc(cond, depth + 1, nodes)?))),
            op if op.starts_with('$') => return Err(format!("unknown operator {op}")),
            path => all.extend(parse_field(path, cond, nodes)?),
        }
    }
    Ok(if all.len() == 1 {
        all.remove(0)
    } else {
        Filter::And(all)
    })
}

fn parse_path(path: &str) -> Result<Vec<String>, String> {
    if path.is_empty() || path.split('.').any(str::is_empty) {
        return Err(format!("invalid field path {path:?}"));
    }
    Ok(path.split('.').map(str::to_owned).collect())
}

/// `{"status": "paid"}` is equality; `{"total": {"$gte": 10, "$lt": 20}}`
/// applies every operator.
fn parse_field(path: &str, cond: &Value, nodes: &mut usize) -> Result<Vec<Filter>, String> {
    let path = parse_path(path)?;
    let ops = match cond {
        Value::Object(map) if map.keys().any(|k| k.starts_with('$')) => map,
        other => {
            return Ok(vec![Filter::Field {
                path,
                op: Op::Eq(other.clone()),
            }]);
        }
    };
    if ops.keys().any(|k| !k.starts_with('$')) {
        return Err(format!(
            "field {:?} mixes operators and plain keys",
            path.join(".")
        ));
    }
    let mut out = Vec::with_capacity(ops.len());
    for (op, arg) in ops {
        count(nodes)?;
        let op = match op.as_str() {
            "$eq" => Op::Eq(arg.clone()),
            "$ne" => Op::Ne(arg.clone()),
            "$gt" => Op::Gt(comparable(op, arg)?),
            "$gte" => Op::Gte(comparable(op, arg)?),
            "$lt" => Op::Lt(comparable(op, arg)?),
            "$lte" => Op::Lte(comparable(op, arg)?),
            "$in" => Op::In(list(op, arg)?),
            "$nin" => Op::Nin(list(op, arg)?),
            "$exists" => Op::Exists(
                arg.as_bool()
                    .ok_or_else(|| "$exists takes true or false".to_owned())?,
            ),
            "$prefix" => Op::Prefix(
                arg.as_str()
                    .ok_or_else(|| "$prefix takes a string".to_owned())?
                    .to_owned(),
            ),
            "$contains" => Op::Contains(arg.clone()),
            other => return Err(format!("unknown operator {other}")),
        };
        out.push(Filter::Field {
            path: path.clone(),
            op,
        });
    }
    Ok(out)
}

fn comparable(op: &str, arg: &Value) -> Result<Value, String> {
    match arg {
        Value::Number(_) | Value::String(_) => Ok(arg.clone()),
        _ => Err(format!("{op} takes a number or a string")),
    }
}

fn list(op: &str, arg: &Value) -> Result<Vec<Value>, String> {
    match arg {
        Value::Array(items) if items.len() <= MAX_IN_VALUES => Ok(items.clone()),
        Value::Array(_) => Err(format!("{op} takes at most {MAX_IN_VALUES} values")),
        _ => Err(format!("{op} takes an array")),
    }
}

/// The value at `path`. Object members are looked up by name and array
/// elements by a numeric segment (`items.0.sku`).
fn lookup<'a>(value: &'a Value, path: &[String]) -> Option<&'a Value> {
    path.iter().try_fold(value, |v, segment| match v {
        Value::Object(map) => map.get(segment),
        Value::Array(items) => segment.parse::<usize>().ok().and_then(|i| items.get(i)),
        _ => None,
    })
}

/// JSON equality where numbers compare by value (`1 == 1.0`).
fn json_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => number_cmp(x, y) == Some(Ordering::Equal),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(a, b)| json_eq(a, b))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, a)| y.get(k).is_some_and(|b| json_eq(a, b)))
        }
        _ => a == b,
    }
}

fn number_cmp(x: &serde_json::Number, y: &serde_json::Number) -> Option<Ordering> {
    if let (Some(a), Some(b)) = (x.as_i64(), y.as_i64()) {
        return Some(a.cmp(&b));
    }
    if let (Some(a), Some(b)) = (x.as_u64(), y.as_u64()) {
        return Some(a.cmp(&b));
    }
    x.as_f64()?.partial_cmp(&y.as_f64()?)
}

/// Orders two numbers or two strings; anything else does not compare.
fn order(a: &Value, b: &Value) -> Option<Ordering> {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => number_cmp(x, y),
        (Value::String(x), Value::String(y)) => Some(x.cmp(y)),
        _ => None,
    }
}

impl Op {
    fn matches(&self, field: Option<&Value>) -> bool {
        use Ordering::{Equal, Greater, Less};
        match (self, field) {
            (Op::Exists(want), f) => f.is_some() == *want,
            (Op::Ne(v), f) => !f.is_some_and(|f| json_eq(f, v)),
            (Op::Nin(vs), f) => !f.is_some_and(|f| vs.iter().any(|v| json_eq(f, v))),
            (_, None) => false,
            (Op::Eq(v), Some(f)) => json_eq(f, v),
            (Op::In(vs), Some(f)) => vs.iter().any(|v| json_eq(f, v)),
            (Op::Gt(v), Some(f)) => order(f, v) == Some(Greater),
            (Op::Gte(v), Some(f)) => matches!(order(f, v), Some(Greater | Equal)),
            (Op::Lt(v), Some(f)) => order(f, v) == Some(Less),
            (Op::Lte(v), Some(f)) => matches!(order(f, v), Some(Less | Equal)),
            (Op::Prefix(p), Some(Value::String(s))) => s.starts_with(p.as_str()),
            (Op::Contains(v), Some(Value::Array(items))) => items.iter().any(|i| json_eq(i, v)),
            (Op::Contains(Value::String(sub)), Some(Value::String(s))) => s.contains(sub.as_str()),
            (Op::Prefix(_) | Op::Contains(_), Some(_)) => false,
        }
    }
}

pub fn parse_fields(fields: &[String]) -> Result<Vec<Vec<String>>, String> {
    fields.iter().map(|f| parse_path(f)).collect()
}

/// Keeps only `fields` of a value. Paths name object members; when a path
/// reaches an array or a scalar, that whole value is kept. Missing paths
/// are left out.
pub fn project(value: &Value, fields: &[Vec<String>]) -> Value {
    let mut out = Value::Object(Map::new());
    for path in fields {
        copy_path(value, &mut out, path);
    }
    out
}

fn copy_path(src: &Value, dst: &mut Value, path: &[String]) {
    let Some((head, rest)) = path.split_first() else {
        return;
    };
    let (Value::Object(src_map), Value::Object(dst_map)) = (src, &mut *dst) else {
        return;
    };
    let Some(child) = src_map.get(head) else {
        return;
    };
    if rest.is_empty() || !child.is_object() {
        dst_map.insert(head.clone(), child.clone());
        return;
    }
    let slot = dst_map
        .entry(head.clone())
        .or_insert_with(|| Value::Object(Map::new()));
    copy_path(child, slot, rest);
}

/// The result of filtering one key range.
#[derive(Debug, Default)]
pub struct FilteredScan {
    pub records: Vec<Record>,
    /// The last key examined, when the scan stopped before the end of the
    /// range (page full or budget spent). The next page starts after it.
    pub resume: Option<Vec<u8>>,
    /// Rows read, matching or not.
    pub scanned: usize,
}

/// Up to `limit` records with keys in `(lo, hi)` that pass `accept` and the
/// filter, reading at most `max_scanned` rows. `accept` runs first and lets
/// a cluster replica skip partitions it does not serve (those rows still
/// count as scanned). Values that are not valid JSON never match a filter.
pub fn filtered_scan(
    engine: &Engine,
    mut lo: Bound<Vec<u8>>,
    hi: Bound<Vec<u8>>,
    filter: Option<&Filter>,
    limit: usize,
    max_scanned: usize,
    accept: impl Fn(&Record) -> bool,
) -> celeris_storage::Result<FilteredScan> {
    let mut out = FilteredScan::default();
    loop {
        let want = SCAN_CHUNK.min(max_scanned - out.scanned).max(1);
        let batch = engine.scan(
            lo.as_ref().map(Vec::as_slice),
            hi.as_ref().map(Vec::as_slice),
            want,
        )?;
        let exhausted = batch.len() < want;
        let count = batch.len();
        for (i, r) in batch.into_iter().enumerate() {
            out.scanned += 1;
            let keep = accept(&r)
                && filter.is_none_or(|f| {
                    serde_json::from_slice::<Value>(&r.value).is_ok_and(|v| f.matches(&v))
                });
            let key = r.key.clone();
            if keep {
                out.records.push(r);
            }
            if out.records.len() >= limit || out.scanned >= max_scanned {
                let range_done = exhausted && i + 1 == count;
                out.resume = (!range_done).then_some(key);
                return Ok(out);
            }
            lo = Bound::Excluded(key);
        }
        if exhausted {
            return Ok(out);
        }
    }
}

/// Merges the parts of one query answered by several replication groups.
///
/// Each part covers the range only up to its `resume` key, so the merged
/// page may hold keys up to the smallest of them. Records beyond it are
/// dropped here and found again on the next page.
pub fn merge_parts(parts: Vec<FilteredScan>, limit: usize) -> FilteredScan {
    let cutoff = parts.iter().filter_map(|p| p.resume.clone()).min();
    let scanned = parts.iter().map(|p| p.scanned).sum();
    let mut records: Vec<Record> = parts
        .into_iter()
        .flat_map(|p| p.records)
        .filter(|r| cutoff.as_ref().is_none_or(|c| r.key <= *c))
        .collect();
    records.sort_by(|a, b| a.key.cmp(&b.key));
    let resume = if records.len() > limit {
        records.truncate(limit);
        records.last().map(|r| r.key.clone())
    } else {
        cutoff
    };
    FilteredScan {
        records,
        resume,
        scanned,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn check(filter: Value, doc: Value) -> bool {
        Filter::parse(&filter).expect("filter").matches(&doc)
    }

    #[test]
    fn equality_operators_and_paths() {
        let order = json!({
            "status": "paid",
            "total": 120,
            "customer": {"tier": "gold", "name": "Ada"},
            "items": [{"sku": "a1"}, {"sku": "b2"}],
            "tags": ["rush", "gift"]
        });
        assert!(check(json!({"status": "paid"}), order.clone()));
        assert!(check(json!({"total": 120.0}), order.clone()));
        assert!(check(
            json!({"total": {"$gte": 100, "$lt": 200}}),
            order.clone()
        ));
        assert!(!check(json!({"total": {"$gt": 120}}), order.clone()));
        assert!(check(
            json!({"customer.tier": {"$in": ["gold", "platinum"]}}),
            order.clone()
        ));
        assert!(check(json!({"items.1.sku": "b2"}), order.clone()));
        assert!(check(json!({"tags": {"$contains": "gift"}}), order.clone()));
        assert!(check(
            json!({"customer.name": {"$prefix": "Ad"}}),
            order.clone()
        ));
        assert!(check(
            json!({"customer.name": {"$contains": "da"}}),
            order.clone()
        ));
        assert!(check(json!({"refund": {"$exists": false}}), order.clone()));
        assert!(check(json!({"refund": {"$ne": true}}), order.clone()));
        assert!(check(json!({"status": {"$nin": ["void"]}}), order.clone()));
        assert!(!check(json!({"refund": {"$gt": 0}}), order.clone()));
        // No ordering across types.
        assert!(!check(json!({"status": {"$gt": 1}}), order.clone()));
        assert!(check(
            json!({"$or": [{"status": "void"}, {"$not": {"total": {"$lt": 100}}}]}),
            order
        ));
    }

    #[test]
    fn invalid_filters_are_rejected() {
        for bad in [
            json!([]),
            json!({"$where": "1"}),
            json!({"a": {"$gt": [1]}}),
            json!({"a": {"$in": 1}}),
            json!({"a": {"$gt": 1, "b": 2}}),
            json!({"a..b": 1}),
            json!({"$or": []}),
            json!({"a": {"$exists": "yes"}}),
        ] {
            assert!(Filter::parse(&bad).is_err(), "{bad}");
        }
        let mut deep = json!({"a": 1});
        for _ in 0..20 {
            deep = json!({"$not": deep});
        }
        assert!(Filter::parse(&deep).is_err());
    }

    #[test]
    fn projection_keeps_named_paths() {
        let doc = json!({"a": 1, "b": {"c": 2, "d": 3}, "e": [1, 2]});
        let fields = parse_fields(&["b.c".into(), "e.0".into(), "zz".into()]).expect("fields");
        assert_eq!(project(&doc, &fields), json!({"b": {"c": 2}, "e": [1, 2]}));
    }

    fn rec(key: &str) -> Record {
        Record {
            key: key.as_bytes().to_vec(),
            value: b"{}".to_vec(),
            version: 1,
            timestamp_ms: 0,
            expires_at_ms: None,
            mutation_id: celeris_core::MutationId::from_u128(0),
        }
    }

    #[test]
    fn merged_pages_never_skip_keys() {
        // Group A stopped at "k5" (budget); group B finished its range.
        let a = FilteredScan {
            records: vec![rec("k1"), rec("k4")],
            resume: Some(b"k5".to_vec()),
            scanned: 10,
        };
        let b = FilteredScan {
            records: vec![rec("k2"), rec("k7")],
            resume: None,
            scanned: 3,
        };
        let page = merge_parts(vec![a, b], 10);
        let keys: Vec<_> = page.records.iter().map(|r| r.key.clone()).collect();
        assert_eq!(keys, vec![b"k1".to_vec(), b"k2".to_vec(), b"k4".to_vec()]);
        assert_eq!(page.resume, Some(b"k5".to_vec()));
        assert_eq!(page.scanned, 13);

        let page = merge_parts(
            vec![
                FilteredScan {
                    records: vec![rec("a"), rec("c")],
                    resume: None,
                    scanned: 2,
                },
                FilteredScan {
                    records: vec![rec("b"), rec("d")],
                    resume: None,
                    scanned: 2,
                },
            ],
            3,
        );
        assert_eq!(page.records.len(), 3);
        assert_eq!(page.resume, Some(b"c".to_vec()));
    }
}
