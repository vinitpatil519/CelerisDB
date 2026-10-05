//! Linearizability checking for a single register (one key).
//!
//! A history is a set of operations with real-time invocation and response
//! times, as observed by clients. It is linearizable if every operation can
//! be placed at a single instant between its invocation and its response
//! such that the resulting sequence is a valid run of a register: every read
//! returns the latest write before it (or "absent" before any write).
//!
//! Writes whose outcome is unknown (the client timed out, or the connection
//! broke) have no response. They may take effect at any point after their
//! invocation, or never. Operations that definitely failed must not be
//! recorded at all.
//!
//! The search is Wing & Gong's algorithm with memoization of
//! (linearized set, register value) states (Lowe, 2017), which keeps
//! realistic histories of a few dozen operations per key fast.

use std::collections::HashSet;

/// What the client asked for and saw.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Op {
    /// Wrote this value (values must be unique per key for good coverage).
    Write(i64),
    /// Read and observed this value (`None`: the key was absent).
    Read(Option<i64>),
}

/// One client operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    /// When the request was sent (any monotonic clock, consistent across
    /// clients).
    pub invoke: u64,
    /// When the answer arrived; `None` if the outcome is unknown.
    pub response: Option<u64>,
    pub op: Op,
}

/// Most operations a history may hold (one bit each in the search state).
pub const MAX_EVENTS: usize = 128;

/// Checks that `history` (all operations on one register, which starts
/// absent) is linearizable. On failure, explains which operations could
/// not be ordered.
pub fn check(history: &[Event]) -> Result<(), String> {
    if history.len() > MAX_EVENTS {
        return Err(format!(
            "history has {} events; the checker supports at most {MAX_EVENTS}",
            history.len()
        ));
    }
    for e in history {
        if matches!(e.op, Op::Read(_)) && e.response.is_none() {
            return Err("reads with unknown outcome carry no information; drop them".into());
        }
        if e.response.is_some_and(|r| r < e.invoke) {
            return Err(format!("event {e:?} responds before it was invoked"));
        }
    }
    let completed: u128 = history
        .iter()
        .enumerate()
        .filter(|(_, e)| e.response.is_some())
        .fold(0, |mask, (i, _)| mask | (1u128 << i));
    let mut seen = HashSet::new();
    let mut best = 0u128;
    if search(history, completed, 0, None, &mut seen, &mut best) {
        Ok(())
    } else {
        let stuck: Vec<String> = history
            .iter()
            .enumerate()
            .filter(|(i, e)| best & (1u128 << i) == 0 && e.response.is_some())
            .map(|(i, e)| format!("#{i} {e:?}"))
            .collect();
        Err(format!(
            "not linearizable: no valid order places these operations: {}",
            stuck.join(", ")
        ))
    }
}

fn search(
    history: &[Event],
    completed: u128,
    done: u128,
    value: Option<i64>,
    seen: &mut HashSet<(u128, Option<i64>)>,
    best: &mut u128,
) -> bool {
    if done & completed == completed {
        return true;
    }
    if !seen.insert((done, value)) {
        return false;
    }
    if (done & completed).count_ones() > (*best & completed).count_ones() {
        *best = done;
    }
    // An operation can go next only if no pending completed operation
    // finished before it started.
    let earliest_response = history
        .iter()
        .enumerate()
        .filter(|(i, _)| done & (1u128 << i) == 0)
        .filter_map(|(_, e)| e.response)
        .min()
        .unwrap_or(u64::MAX);
    for (i, e) in history.iter().enumerate() {
        let bit = 1u128 << i;
        if done & bit != 0 || e.invoke > earliest_response {
            continue;
        }
        let next = match &e.op {
            Op::Write(v) => Some(*v),
            Op::Read(observed) if *observed == value => value,
            Op::Read(_) => continue,
        };
        if search(history, completed, done | bit, next, seen, best) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(invoke: u64, response: Option<u64>, op: Op) -> Event {
        Event {
            invoke,
            response,
            op,
        }
    }

    #[test]
    fn sequential_histories_check() {
        let h = [
            ev(0, Some(1), Op::Read(None)),
            ev(2, Some(3), Op::Write(1)),
            ev(4, Some(5), Op::Read(Some(1))),
            ev(6, Some(7), Op::Write(2)),
            ev(8, Some(9), Op::Read(Some(2))),
        ];
        assert_eq!(check(&h), Ok(()));
    }

    #[test]
    fn stale_reads_after_a_completed_write_are_caught() {
        let h = [
            ev(0, Some(1), Op::Write(1)),
            ev(2, Some(3), Op::Write(2)),
            ev(4, Some(5), Op::Read(Some(1))),
        ];
        assert!(check(&h).is_err());
    }

    #[test]
    fn concurrent_operations_may_order_either_way() {
        let h = [
            ev(0, Some(10), Op::Write(1)),
            ev(1, Some(9), Op::Write(2)),
            ev(11, Some(12), Op::Read(Some(1))),
        ];
        assert_eq!(check(&h), Ok(()), "write 2 then write 1");
        let h = [
            ev(0, Some(10), Op::Write(1)),
            ev(1, Some(9), Op::Read(Some(1))),
            ev(11, Some(12), Op::Read(None)),
        ];
        assert!(check(&h).is_err(), "a value cannot disappear");
    }

    #[test]
    fn unknown_writes_may_apply_late_or_never() {
        let never = [ev(0, None, Op::Write(7)), ev(5, Some(6), Op::Read(None))];
        assert_eq!(check(&never), Ok(()));
        let late = [
            ev(0, None, Op::Write(7)),
            ev(5, Some(6), Op::Read(None)),
            ev(8, Some(9), Op::Read(Some(7))),
        ];
        assert_eq!(check(&late), Ok(()));
        let flicker = [
            ev(0, None, Op::Write(7)),
            ev(5, Some(6), Op::Read(Some(7))),
            ev(8, Some(9), Op::Read(None)),
        ];
        assert!(check(&flicker).is_err(), "once seen, it stays");
    }

    #[test]
    fn large_concurrent_histories_finish_quickly() {
        // Overlapping operations consistent with a register that applies
        // each write at its invocation.
        let mut h = Vec::new();
        let mut current = None;
        for i in 0..120u64 {
            let t = i * 10;
            if i % 3 == 0 {
                current = Some(i as i64);
                h.push(ev(t, Some(t + 25), Op::Write(i as i64)));
            } else {
                h.push(ev(t, Some(t + 25), Op::Read(current)));
            }
        }
        let start = std::time::Instant::now();
        assert_eq!(check(&h), Ok(()));
        assert!(start.elapsed().as_secs() < 5);
    }
}
