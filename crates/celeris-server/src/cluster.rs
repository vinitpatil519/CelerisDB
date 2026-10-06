//! Internal node-to-node transport, plus the membership and control-plane
//! (Raft) runtimes.
//!
//! Cluster traffic uses its own port and never shares a listener with the
//! client API. Frame format, version 2:
//!
//! ```text
//! magic "CLRS" (4) | version u8 | length u32 big-endian | JSON body
//! body: {"channel": "membership", "body": <membership message>}
//!     | {"channel": "raft", "body": {"from": <node id>, "message": <raft message>}}
//! ```
//!
//! Each frame travels on its own short-lived TCP connection. Both protocols
//! tolerate loss (Raft retries through heartbeats), so sends are
//! fire-and-forget with a timeout.
//!
//! A replication-group snapshot (sent to a replica that needs entries the
//! leader has compacted away) is too large for a frame and travels on its
//! own connection, version 1:
//!
//! ```text
//! magic "CLSN" (4) | version u8 | header length u32 BE | JSON header
//!                  | data length u64 BE | engine snapshot bytes
//! header: {"group", "from", "term", "last_included_index", "last_included_term"}
//! ```
//!
//! The engine snapshot carries its own magic, version and checksum. The
//! snapshot is held in memory on both ends, so its size is capped by
//! [`MAX_SNAPSHOT_BYTES`].

use std::sync::Arc;
use std::time::Duration;

use celeris_cluster::Message;
use celeris_cluster::raft::{ControlCommand, Envelope, LogIndex, Raft, RaftMessage, Term};
use celeris_core::partition::NodeId;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;
use tracing::{debug, info, warn};

use crate::groups::{DataCommand, ReplicaGroup, SnapshotPayload};
use crate::node::Node;

const MAGIC: &[u8; 4] = b"CLRS";
/// Current cluster frame version. v2 added the Raft channel.
pub const FRAME_VERSION: u8 = 2;
const HEADER_LEN: usize = 9;
/// Fits one maximal write batch (32 MiB of keys and values, which JSON
/// escaping can double) in a single Raft append.
const MAX_FRAME_BYTES: usize = 128 * 1024 * 1024;
/// Frames above this size are encoded and decoded on the blocking pool.
const BULKY_FRAME_BYTES: usize = 256 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(1);
/// A pooled connection to a peer closes after this long without frames.
/// The receiving side waits longer, so it never closes a connection the
/// sender is about to use.
const POOL_IDLE: Duration = Duration::from_secs(20);
const INBOUND_IDLE: Duration = Duration::from_secs(60);
/// Frames queued per peer; beyond this new frames are dropped (Raft and
/// gossip resend what matters).
const POOL_QUEUE: usize = 1024;
const SNAPSHOT_MAGIC: &[u8; 4] = b"CLSN";
/// Current snapshot stream version.
pub const SNAPSHOT_STREAM_VERSION: u8 = 1;
const MAX_SNAPSHOT_HEADER_BYTES: usize = 64 * 1024;
/// Largest group snapshot a node sends or accepts.
pub const MAX_SNAPSHOT_BYTES: u64 = 1024 * 1024 * 1024;
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(120);
/// How often groups that failed to open are retried.
const GROUP_CHECK_MS: u64 = 1_000;
/// How often pending `available` writes are offered to their groups.
const RECONCILE_PASS_MS: u64 = 300;
/// How often running partition migrations are pushed forward.
const MIGRATION_PASS_MS: u64 = 200;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct SnapshotHeader {
    group: String,
    from: NodeId,
    term: Term,
    last_included_index: LogIndex,
    last_included_term: Term,
}

/// What arrived on an inbound cluster connection.
#[derive(Debug)]
enum Inbound {
    Frame(Frame),
    Snapshot(SnapshotHeader, Vec<u8>),
    /// A request whose answer goes back on the same connection.
    Rpc(RpcRequest),
}

const RPC_REQUEST_MAGIC: &[u8; 4] = b"CLXR";
const RPC_RESPONSE_MAGIC: &[u8; 4] = b"CLXS";
/// Version of the request/response exchange.
pub const RPC_VERSION: u8 = 2;

/// Node-to-node requests that need an answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum RpcRequest {
    /// A migration destination asks a source replica for fenced
    /// partitions' data (D-020). Answer: `Vec<ImportEntry>`.
    Export { group: String, partitions: Vec<u16> },
    /// A cluster-wide scan asks a group replica for its part of a range.
    /// Answer: `Vec<WireRecord>`.
    Scan {
        group: String,
        range: crate::replicated::ScanRange,
        strict: bool,
    },
    /// A cluster-wide query asks a group replica to filter its part of a
    /// range (D-030). Answer: `WireQueryPart`.
    Query {
        group: String,
        range: crate::replicated::QueryRange,
        strict: bool,
    },
    /// A node holding a pending `available` write asks the group leader to
    /// commit it (D-023). Answer: `()` once applied.
    Forward { group: String, command: DataCommand },
    /// Recorded conflicts of keys with a prefix, from one group. Answer:
    /// `Vec<Conflict>`.
    Conflicts {
        group: String,
        prefix: String,
        limit: usize,
    },
    /// The replica's digest for a `Digest` entry. Answer:
    /// `Option<BTreeMap<u16, u64>>` (`None`: not applied yet).
    Digest { group: String, id: String },
    /// Anti-entropy found this replica's data diverged: accept the
    /// leader's next snapshot. Answer: `()`.
    Repair { group: String },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "channel", content = "body", rename_all = "snake_case")]
pub(crate) enum Frame {
    Membership(Message),
    Raft {
        from: NodeId,
        message: RaftMessage<ControlCommand>,
    },
    /// Raft traffic of a data replication group.
    Group {
        group: String,
        from: NodeId,
        message: RaftMessage<DataCommand>,
    },
    /// A control command for the control-plane leader to propose (sent by
    /// nodes that are not the leader, e.g. to advance a migration).
    ControlPropose {
        command: ControlCommand,
    },
}

/// Runs a call on a replication group's Raft node on the blocking pool,
/// then sends the resulting messages (only if persisting succeeded).
pub(crate) async fn group_call<R, F>(node: &Arc<Node>, group: Arc<ReplicaGroup>, f: F) -> Option<R>
where
    R: Send + 'static,
    F: FnOnce(&mut Raft<DataCommand>, u64) -> (R, Vec<Envelope<DataCommand>>) + Send + 'static,
{
    let now = node.now_ms();
    let worker = Arc::clone(&group);
    let outcome = tokio::task::spawn_blocking(move || worker.drive(now, f))
        .await
        .ok()?;
    match outcome {
        Ok((result, out)) => {
            send_group(node, &group, out);
            Some(result)
        }
        Err(_) => None,
    }
}

/// Sends replication-group Raft messages to their members. A request to
/// install a snapshot becomes a snapshot transfer.
pub(crate) fn send_group(
    node: &Arc<Node>,
    group: &Arc<ReplicaGroup>,
    out: Vec<Envelope<DataCommand>>,
) {
    for e in out {
        let Some(addr) = node.member_addr(&e.to) else {
            debug!(peer = %e.to, group = group.id(), "no cluster address for group peer yet");
            continue;
        };
        if let RaftMessage::InstallSnapshot { .. } = e.message {
            tokio::spawn(send_snapshot(
                Arc::clone(node),
                Arc::clone(group),
                e.to,
                addr,
            ));
            continue;
        }
        let bulky =
            matches!(&e.message, RaftMessage::Append { entries, .. } if !entries.is_empty());
        let frame = Frame::Group {
            group: group.id().to_owned(),
            from: node.node_id().clone(),
            message: e.message,
        };
        if bulky {
            // Entries can be megabytes; encode them off the runtime threads.
            tokio::spawn(async move {
                if let Ok(bytes) = tokio::task::spawn_blocking(move || encode(&frame)).await {
                    send(addr, bytes).await;
                }
            });
        } else {
            tokio::spawn(send(addr, encode(&frame)));
        }
    }
}

/// Streams the group's current data state to `peer`, unless a transfer to
/// it is already running.
async fn send_snapshot(node: Arc<Node>, group: Arc<ReplicaGroup>, peer: NodeId, addr: String) {
    push_snapshot(node, group, peer, addr, false).await;
}

/// Streams the group's state to `peer`; `force` skips the per-peer resend
/// throttle (anti-entropy repair).
pub(crate) async fn push_snapshot(
    node: Arc<Node>,
    group: Arc<ReplicaGroup>,
    peer: NodeId,
    addr: String,
    force: bool,
) {
    let now = node.now_ms();
    let worker = Arc::clone(&group);
    let target = peer.clone();
    let payload =
        match tokio::task::spawn_blocking(move || worker.snapshot_payload(&target, now, force))
            .await
        {
            Ok(Ok(Some(payload))) => payload,
            Ok(Ok(None)) => return,
            Ok(Err(e)) => {
                warn!(group = group.id(), %peer, error = %e, "could not build snapshot");
                group.snapshot_sent(&peer, None);
                return;
            }
            Err(e) => {
                warn!(group = group.id(), %peer, error = %e, "snapshot task failed");
                group.snapshot_sent(&peer, None);
                return;
            }
        };
    let bytes = payload.data.len();
    let index = payload.last_included_index;
    let header = SnapshotHeader {
        group: group.id().to_owned(),
        from: node.node_id().clone(),
        term: payload.term,
        last_included_index: payload.last_included_index,
        last_included_term: payload.last_included_term,
    };
    let result = match encode_snapshot(&header, &payload.data) {
        Ok(stream) => tokio::time::timeout(SNAPSHOT_TIMEOUT, async {
            let mut conn = TcpStream::connect(&addr).await?;
            conn.write_all(&stream).await?;
            conn.shutdown().await
        })
        .await
        .map_err(|_| anyhow::anyhow!("timed out"))
        .and_then(|r| r.map_err(anyhow::Error::from)),
        Err(e) => Err(e),
    };
    match result {
        Ok(()) => {
            group.snapshot_sent(&peer, Some(node.now_ms()));
            info!(group = group.id(), %peer, index, bytes, "sent snapshot");
        }
        Err(e) => {
            group.snapshot_sent(&peer, None);
            warn!(group = group.id(), %peer, error = %e, "snapshot transfer failed");
        }
    }
}

fn encode_snapshot(header: &SnapshotHeader, data: &[u8]) -> anyhow::Result<Vec<u8>> {
    anyhow::ensure!(
        data.len() as u64 <= MAX_SNAPSHOT_BYTES,
        "snapshot of {} bytes exceeds the {MAX_SNAPSHOT_BYTES}-byte limit",
        data.len()
    );
    let head = serde_json::to_vec(header)?;
    let mut out = Vec::with_capacity(4 + 1 + 4 + head.len() + 8 + data.len());
    out.extend_from_slice(SNAPSHOT_MAGIC);
    out.push(SNAPSHOT_STREAM_VERSION);
    out.extend_from_slice(&(head.len() as u32).to_be_bytes());
    out.extend_from_slice(&head);
    out.extend_from_slice(&(data.len() as u64).to_be_bytes());
    out.extend_from_slice(data);
    Ok(out)
}

/// Reads a snapshot stream after its magic.
async fn read_snapshot<R: AsyncReadExt + Unpin>(
    stream: &mut R,
) -> anyhow::Result<(SnapshotHeader, Vec<u8>)> {
    let version = stream.read_u8().await?;
    anyhow::ensure!(
        version == SNAPSHOT_STREAM_VERSION,
        "unsupported snapshot stream version {version} (this node speaks {SNAPSHOT_STREAM_VERSION})"
    );
    let head_len = stream.read_u32().await? as usize;
    anyhow::ensure!(
        head_len <= MAX_SNAPSHOT_HEADER_BYTES,
        "snapshot header too large ({head_len} bytes)"
    );
    let mut head = vec![0u8; head_len];
    stream.read_exact(&mut head).await?;
    let header: SnapshotHeader = serde_json::from_slice(&head)?;
    let len = stream.read_u64().await?;
    anyhow::ensure!(
        len <= MAX_SNAPSHOT_BYTES,
        "snapshot too large ({len} bytes)"
    );
    let mut data = Vec::new();
    (&mut *stream).take(len).read_to_end(&mut data).await?;
    anyhow::ensure!(data.len() as u64 == len, "truncated snapshot");
    Ok((header, data))
}

/// Reads the next frame of a pooled connection. `None` when the sender
/// closed it, or it stayed idle for `INBOUND_IDLE`.
async fn read_next_frame(stream: &mut TcpStream) -> anyhow::Result<Option<Frame>> {
    let mut magic = [0u8; 4];
    match tokio::time::timeout(INBOUND_IDLE, stream.read_exact(&mut magic)).await {
        Err(_) => return Ok(None),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Ok(Err(e)) => return Err(e.into()),
        Ok(Ok(_)) => {}
    }
    anyhow::ensure!(&magic == MAGIC, "not a Celeris cluster frame");
    Ok(Some(read_frame_after_magic(stream).await?))
}

/// Reads one inbound connection: a frame (timeout scaled to its size) or a
/// snapshot stream (long timeout).
async fn read_inbound(stream: &mut TcpStream) -> anyhow::Result<Inbound> {
    let mut magic = [0u8; 4];
    tokio::time::timeout(IO_TIMEOUT, stream.read_exact(&mut magic))
        .await
        .map_err(|_| anyhow::anyhow!("read timed out"))??;
    if &magic == MAGIC {
        Ok(Inbound::Frame(read_frame_after_magic(stream).await?))
    } else if &magic == SNAPSHOT_MAGIC {
        let (header, data) = tokio::time::timeout(SNAPSHOT_TIMEOUT, read_snapshot(stream))
            .await
            .map_err(|_| anyhow::anyhow!("snapshot read timed out"))??;
        Ok(Inbound::Snapshot(header, data))
    } else if &magic == RPC_REQUEST_MAGIC {
        let request = tokio::time::timeout(IO_TIMEOUT, async {
            let version = stream.read_u8().await?;
            anyhow::ensure!(version == RPC_VERSION, "unsupported rpc version {version}");
            let len = stream.read_u32().await? as usize;
            anyhow::ensure!(len <= MAX_FRAME_BYTES, "rpc request too large");
            let mut body = vec![0u8; len];
            stream.read_exact(&mut body).await?;
            Ok(serde_json::from_slice::<RpcRequest>(&body)?)
        })
        .await
        .map_err(|_| anyhow::anyhow!("rpc request read timed out"))??;
        Ok(Inbound::Rpc(request))
    } else {
        anyhow::bail!("not a Celeris cluster frame")
    }
}

/// Answers a request from another node on the same connection.
async fn handle_rpc(node: Arc<Node>, request: RpcRequest, stream: &mut TcpStream) {
    let result: anyhow::Result<Vec<u8>> = match request {
        RpcRequest::Export { group, partitions } => match node.group(&group) {
            None => Err(anyhow::anyhow!("no replication group {group} here")),
            Some(group) => {
                let now = celeris_storage::Clock::now_ms(&celeris_storage::SystemClock);
                tokio::task::spawn_blocking(move || {
                    group
                        .export(&partitions, now)
                        .and_then(|entries| Ok(serde_json::to_vec(&entries)?))
                })
                .await
                .unwrap_or_else(|e| Err(anyhow::anyhow!("export task failed: {e}")))
            }
        },
        RpcRequest::Scan {
            group,
            range,
            strict,
        } => match node.group(&group) {
            None => Err(anyhow::anyhow!("no replication group {group} here")),
            Some(group) => crate::replicated::local_group_scan(&node, &group, &range, strict)
                .await
                .and_then(|records| Ok(serde_json::to_vec(&records)?)),
        },
        RpcRequest::Query {
            group,
            range,
            strict,
        } => match node.group(&group) {
            None => Err(anyhow::anyhow!("no replication group {group} here")),
            Some(group) => crate::replicated::local_group_query(&node, &group, &range, strict)
                .await
                .and_then(|part| Ok(serde_json::to_vec(&part)?)),
        },
        RpcRequest::Forward { group, command } => match node.group(&group) {
            None => Err(anyhow::anyhow!("no replication group {group} here")),
            Some(group) => crate::available::commit_locally(&node, &group, command)
                .await
                .and_then(|()| Ok(serde_json::to_vec(&())?)),
        },
        RpcRequest::Conflicts {
            group,
            prefix,
            limit,
        } => match node.group(&group) {
            None => Err(anyhow::anyhow!("no replication group {group} here")),
            Some(group) => tokio::task::spawn_blocking(move || {
                group
                    .conflicts(&prefix, limit)
                    .and_then(|c| Ok(serde_json::to_vec(&c)?))
            })
            .await
            .unwrap_or_else(|e| Err(anyhow::anyhow!("conflict task failed: {e}"))),
        },
        RpcRequest::Digest { group, id } => match node.group(&group) {
            None => Err(anyhow::anyhow!("no replication group {group} here")),
            Some(group) => Ok(serde_json::to_vec(&group.digest(&id)).unwrap_or_default()),
        },
        RpcRequest::Repair { group } => match node.group(&group) {
            None => Err(anyhow::anyhow!("no replication group {group} here")),
            Some(group) => {
                group.request_repair();
                Ok(serde_json::to_vec(&()).unwrap_or_default())
            }
        },
    };
    let (status, body) = match result {
        Ok(body) if body.len() as u64 <= MAX_SNAPSHOT_BYTES => (0u8, body),
        Ok(body) => (
            1,
            format!("answer of {} bytes is too large", body.len()).into_bytes(),
        ),
        Err(e) => (1, format!("{e:#}").into_bytes()),
    };
    let mut out = Vec::with_capacity(body.len() + 14);
    out.extend_from_slice(RPC_RESPONSE_MAGIC);
    out.push(RPC_VERSION);
    out.push(status);
    out.extend_from_slice(&(body.len() as u64).to_be_bytes());
    out.extend_from_slice(&body);
    let sent = tokio::time::timeout(SNAPSHOT_TIMEOUT, async {
        stream.write_all(&out).await?;
        stream.shutdown().await
    })
    .await;
    if !matches!(sent, Ok(Ok(()))) {
        debug!("rpc response not delivered");
    }
}

/// Sends a request to the node at `addr` and parses its answer.
pub(crate) async fn rpc<T: serde::de::DeserializeOwned + Send + 'static>(
    addr: &str,
    request: &RpcRequest,
    timeout: Duration,
) -> anyhow::Result<T> {
    let request = serde_json::to_vec(request)?;
    tokio::time::timeout(timeout, async {
        let mut conn = TcpStream::connect(addr).await?;
        let mut head = RPC_REQUEST_MAGIC.to_vec();
        head.push(RPC_VERSION);
        head.extend_from_slice(&(request.len() as u32).to_be_bytes());
        head.extend_from_slice(&request);
        conn.write_all(&head).await?;
        let mut magic = [0u8; 4];
        conn.read_exact(&mut magic).await?;
        anyhow::ensure!(&magic == RPC_RESPONSE_MAGIC, "not an rpc response");
        let version = conn.read_u8().await?;
        anyhow::ensure!(version == RPC_VERSION, "unsupported rpc version {version}");
        let status = conn.read_u8().await?;
        let len = conn.read_u64().await?;
        anyhow::ensure!(len <= MAX_SNAPSHOT_BYTES, "answer too large ({len} bytes)");
        let mut body = Vec::new();
        (&mut conn).take(len).read_to_end(&mut body).await?;
        anyhow::ensure!(body.len() as u64 == len, "truncated answer");
        anyhow::ensure!(
            status == 0,
            "peer refused: {}",
            String::from_utf8_lossy(&body)
        );
        Ok(tokio::task::spawn_blocking(move || serde_json::from_slice(&body)).await??)
    })
    .await
    .map_err(|_| anyhow::anyhow!("request to {addr} timed out"))?
}

/// Fetches fenced partitions' data from a source replica at `addr`.
pub(crate) async fn fetch_export(
    addr: &str,
    group: &str,
    partitions: &[u16],
) -> anyhow::Result<Vec<crate::groups::ImportEntry>> {
    let request = RpcRequest::Export {
        group: group.to_owned(),
        partitions: partitions.to_vec(),
    };
    rpc(addr, &request, SNAPSHOT_TIMEOUT).await
}
/// Gets a control command proposed by whichever voter currently leads:
/// tried locally, and forwarded to every other member.
pub(crate) async fn propose_control(node: &Arc<Node>, command: ControlCommand) {
    let local = command.clone();
    raft_call(node, move |raft, _| match raft.propose(local) {
        Ok((_, out)) => ((), out),
        Err(_) => ((), Vec::new()),
    })
    .await;
    let peers: Vec<String> = node
        .cluster_members()
        .map(|(_, members)| {
            members
                .into_iter()
                .filter(|m| m.id != *node.node_id())
                .map(|m| m.addr)
                .collect()
        })
        .unwrap_or_default();
    for addr in peers {
        let frame = Frame::ControlPropose {
            command: command.clone(),
        };
        tokio::spawn(send(addr, encode(&frame)));
    }
}

/// Forwards a placement request to the control-plane leader. The caller
/// has validated it; the leader's state machine checks it again. Returns
/// `false` if the leader's address is unknown.
pub(crate) fn forward_rebalance(node: &Node, leader: &NodeId, rf: u8) -> bool {
    let Some(addr) = node.member_addr(leader) else {
        return false;
    };
    let Some(nodes) = node.with_membership(|m, _| m.placement_nodes()) else {
        return false;
    };
    let frame = Frame::ControlPropose {
        command: ControlCommand::SetNodes {
            nodes,
            replication_factor: rf,
        },
    };
    tokio::spawn(send(addr, encode(&frame)));
    true
}

async fn handle_snapshot(node: Arc<Node>, header: SnapshotHeader, data: Vec<u8>) {
    let Some(group) = node.group(&header.group) else {
        debug!(
            group = header.group,
            "snapshot for an unknown replication group"
        );
        return;
    };
    let now = node.now_ms();
    let worker = Arc::clone(&group);
    let from = header.from.clone();
    let payload = SnapshotPayload {
        term: header.term,
        last_included_index: header.last_included_index,
        last_included_term: header.last_included_term,
        data,
    };
    match tokio::task::spawn_blocking(move || worker.install_snapshot(now, from, payload)).await {
        Ok(Ok(out)) => send_group(&node, &group, out),
        Ok(Err(e)) => warn!(group = header.group, error = %e, "snapshot install failed"),
        Err(e) => warn!(group = header.group, error = %e, "snapshot install task failed"),
    }
}

pub(crate) fn encode(frame: &Frame) -> Vec<u8> {
    // Frames contain only strings, integers and enums; serializing them
    // cannot fail.
    let body = serde_json::to_vec(frame).unwrap_or_default();
    let mut out = Vec::with_capacity(HEADER_LEN + body.len());
    out.extend_from_slice(MAGIC);
    out.push(FRAME_VERSION);
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(&body);
    out
}

#[cfg(test)]
pub(crate) async fn read_frame<R: AsyncReadExt + Unpin>(stream: &mut R) -> anyhow::Result<Frame> {
    let mut magic = [0u8; 4];
    stream.read_exact(&mut magic).await?;
    anyhow::ensure!(&magic == MAGIC, "not a Celeris cluster frame");
    read_frame_after_magic(stream).await
}

async fn read_frame_after_magic<R: AsyncReadExt + Unpin>(stream: &mut R) -> anyhow::Result<Frame> {
    let mut header = [0u8; HEADER_LEN - 4];
    tokio::time::timeout(IO_TIMEOUT, stream.read_exact(&mut header))
        .await
        .map_err(|_| anyhow::anyhow!("frame header read timed out"))??;
    anyhow::ensure!(
        header[0] == FRAME_VERSION,
        "unsupported cluster frame version {} (this node speaks {FRAME_VERSION})",
        header[0]
    );
    let len = u32::from_be_bytes([header[1], header[2], header[3], header[4]]) as usize;
    anyhow::ensure!(
        len <= MAX_FRAME_BYTES,
        "cluster frame too large ({len} bytes)"
    );
    // Grows with the data that actually arrives rather than trusting the
    // declared length up front.
    let mut body = Vec::new();
    tokio::time::timeout(
        transfer_timeout(len),
        (&mut *stream).take(len as u64).read_to_end(&mut body),
    )
    .await
    .map_err(|_| anyhow::anyhow!("frame body read timed out"))??;
    anyhow::ensure!(body.len() == len, "truncated cluster frame");
    if len > BULKY_FRAME_BYTES {
        // Parsing megabytes of JSON would stall this runtime thread (and
        // with it gossip and heartbeats).
        return tokio::task::spawn_blocking(move || serde_json::from_slice(&body))
            .await?
            .map_err(Into::into);
    }
    Ok(serde_json::from_slice(&body)?)
}

/// Time allowed to move `bytes`: the base I/O timeout plus 1 ms per 4 KiB
/// (a floor of 4 MiB/s).
fn transfer_timeout(bytes: usize) -> Duration {
    IO_TIMEOUT + Duration::from_millis((bytes / 4096) as u64)
}

/// Per-peer senders of the connection pool, by cluster address.
static POOL: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, tokio::sync::mpsc::Sender<Vec<u8>>>>,
> = std::sync::LazyLock::new(Default::default);

/// Sends a frame to a peer, best-effort. Small frames share one long-lived
/// connection per peer (in order), so heartbeats and gossip do not open a
/// connection each, which would exhaust ephemeral ports with sockets in
/// TIME_WAIT. Bulky frames get their own connection so they do not hold
/// up the small ones.
async fn send(addr: String, frame: Vec<u8>) {
    if frame.len() > BULKY_FRAME_BYTES {
        return send_direct(addr, frame).await;
    }
    let mut frame = frame;
    for _ in 0..2 {
        let tx = POOL
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(addr.clone())
            .or_insert_with(|| spawn_writer(addr.clone()))
            .clone();
        match tx.try_send(frame) {
            Ok(()) => return,
            Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                debug!(%addr, "cluster send queue full; dropping a frame");
                return;
            }
            Err(tokio::sync::mpsc::error::TrySendError::Closed(f)) => {
                // The writer exited (idle, or its runtime stopped): replace it.
                frame = f;
                let mut pool = POOL
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if pool.get(&addr).is_some_and(|t| t.same_channel(&tx)) {
                    pool.remove(&addr);
                }
            }
        }
    }
}

/// Owns the pooled connection to one peer: connects on demand, writes
/// queued frames in order, reconnects after an error (dropping the frame
/// that failed), and exits when idle.
fn spawn_writer(addr: String) -> tokio::sync::mpsc::Sender<Vec<u8>> {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(POOL_QUEUE);
    tokio::spawn(async move {
        let mut stream: Option<TcpStream> = None;
        while let Ok(Some(frame)) = tokio::time::timeout(POOL_IDLE, rx.recv()).await {
            if stream.is_none() {
                match tokio::time::timeout(IO_TIMEOUT, TcpStream::connect(&addr)).await {
                    Ok(Ok(s)) => {
                        let _ = s.set_nodelay(true);
                        stream = Some(s);
                    }
                    Ok(Err(e)) => {
                        debug!(%addr, error = %e, "cluster connect failed");
                        continue;
                    }
                    Err(_) => {
                        debug!(%addr, "cluster connect timed out");
                        continue;
                    }
                }
            }
            if let Some(s) = stream.as_mut() {
                let written =
                    tokio::time::timeout(transfer_timeout(frame.len()), s.write_all(&frame)).await;
                if !matches!(written, Ok(Ok(()))) {
                    debug!(%addr, "cluster send failed; reconnecting");
                    stream = None;
                }
            }
        }
        rx.close();
        let mut pool = POOL
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if pool
            .get(&addr)
            .is_some_and(tokio::sync::mpsc::Sender::is_closed)
        {
            pool.remove(&addr);
        }
    });
    tx
}

/// Sends a frame over a connection of its own and waits until it is
/// written.
async fn send_direct(addr: String, frame: Vec<u8>) {
    let result = tokio::time::timeout(transfer_timeout(frame.len()), async {
        let mut stream = TcpStream::connect(&addr).await?;
        stream.write_all(&frame).await?;
        stream.shutdown().await
    })
    .await;
    match result {
        Ok(Ok(())) => {}
        Ok(Err(e)) => debug!(%addr, error = %e, "cluster send failed"),
        Err(_) => debug!(%addr, "cluster send timed out"),
    }
}

fn dispatch_membership(outs: Vec<celeris_cluster::Outgoing>) {
    for o in outs {
        tokio::spawn(send(o.addr, encode(&Frame::Membership(o.message))));
    }
}

/// Sends Raft messages to peers, addressed through the membership view.
/// A peer with no known address yet is skipped; Raft resends on heartbeat.
pub(crate) fn send_raft(node: &Node, out: Vec<Envelope<ControlCommand>>) {
    for e in out {
        match node.member_addr(&e.to) {
            Some(addr) => {
                let frame = Frame::Raft {
                    from: node.node_id().clone(),
                    message: e.message,
                };
                tokio::spawn(send(addr, encode(&frame)));
            }
            None => debug!(peer = %e.to, "no cluster address for raft peer yet"),
        }
    }
}

/// Runs a Raft call on the blocking pool (it may fsync), then sends the
/// resulting messages. Returns `None` when the node is not a voter or
/// persisting failed (in which case nothing is sent).
pub(crate) async fn raft_call<R, F>(node: &Arc<Node>, f: F) -> Option<R>
where
    R: Send + 'static,
    F: FnOnce(&mut Raft<ControlCommand>, u64) -> (R, Vec<Envelope<ControlCommand>>)
        + Send
        + 'static,
{
    let worker = Arc::clone(node);
    let outcome = tokio::task::spawn_blocking(move || worker.with_raft(f))
        .await
        .ok()??;
    match outcome {
        Ok((result, out)) => {
            send_raft(node, out);
            Some(result)
        }
        Err(_) => None,
    }
}

async fn handle_frame(node: Arc<Node>, frame: Frame) {
    match frame {
        Frame::Membership(msg) => {
            dispatch_membership(
                node.with_membership(|m, now| m.handle(now, msg))
                    .unwrap_or_default(),
            );
        }
        Frame::Raft { from, message } => {
            raft_call(&node, move |raft, now| ((), raft.step(now, from, message))).await;
        }
        Frame::ControlPropose { command } => {
            // Only the leader can propose; everyone else ignores it.
            raft_call(&node, move |raft, _| match raft.propose(command) {
                Ok((_, out)) => ((), out),
                Err(_) => ((), Vec::new()),
            })
            .await;
        }
        Frame::Group {
            group,
            from,
            message,
        } => match node.group(&group) {
            Some(g) => {
                group_call(&node, g, move |raft, now| {
                    ((), raft.step(now, from, message))
                })
                .await;
            }
            // This node has not applied the map that creates the group yet;
            // the leader retries on its next heartbeat.
            None => debug!(group, "message for an unknown replication group"),
        },
    }
}

/// Runs membership (and Raft, on voters) until `stop` flips to true, then
/// announces a graceful leave and waits (bounded by the send timeout) for it.
pub(crate) async fn run(node: Arc<Node>, listener: TcpListener, mut stop: watch::Receiver<bool>) {
    let gossip_ms = node
        .with_membership(|m, _| m.config().heartbeat_interval_ms)
        .unwrap_or(500);
    // Raft needs finer-grained ticks than gossip to hit its deadlines.
    let tick_ms = node
        .raft_tick_ms()
        .map_or(gossip_ms, |r| r.min(gossip_ms))
        .max(5);
    let mut ticker = tokio::time::interval(Duration::from_millis(tick_ms));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut since_gossip = gossip_ms;
    let mut since_group_check = 0;
    let mut since_migration = 0;
    let mut since_reconcile = 0;
    let mut since_check = 0;
    loop {
        tokio::select! {
            _ = ticker.tick() => {
                since_gossip += tick_ms;
                if since_gossip >= gossip_ms {
                    since_gossip = 0;
                    dispatch_membership(node.with_membership(|m, now| m.tick(now)).unwrap_or_default());
                }
                since_group_check += tick_ms;
                if since_group_check >= GROUP_CHECK_MS {
                    since_group_check = 0;
                    let worker = Arc::clone(&node);
                    let _ = tokio::task::spawn_blocking(move || worker.reopen_missing_groups()).await;
                }
                if since_group_check == 0 && node.is_voter() {
                    let worker = Arc::clone(&node);
                    if let Ok(out) = tokio::task::spawn_blocking(move || worker.auto_rebalance()).await {
                        send_raft(&node, out);
                    }
                }
                since_check += tick_ms;
                let interval = node.anti_entropy_interval_ms();
                if interval > 0 && since_check >= interval && node.begin_check() {
                    since_check = 0;
                    let worker = Arc::clone(&node);
                    tokio::spawn(async move {
                        crate::anti_entropy::check(&worker).await;
                        worker.end_check();
                    });
                }
                since_reconcile += tick_ms;
                if since_reconcile >= RECONCILE_PASS_MS && node.begin_reconcile_pass() {
                    since_reconcile = 0;
                    let worker = Arc::clone(&node);
                    tokio::spawn(async move {
                        crate::available::reconcile(&worker).await;
                        worker.end_reconcile_pass();
                    });
                }
                since_migration += tick_ms;
                if since_migration >= MIGRATION_PASS_MS && node.begin_migration_pass() {
                    since_migration = 0;
                    let worker = Arc::clone(&node);
                    tokio::spawn(async move {
                        crate::migration::drive(&worker).await;
                        worker.end_migration_pass();
                    });
                }
                if node.is_voter() {
                    raft_call(&node, |raft, now| ((), raft.tick(now))).await;
                }
                for group in node.groups() {
                    group_call(&node, group, |raft, now| ((), raft.tick(now))).await;
                }
            }
            accepted = listener.accept() => match accepted {
                Ok((mut stream, peer)) => {
                    let node = Arc::clone(&node);
                    tokio::spawn(async move {
                        match read_inbound(&mut stream).await {
                            Ok(Inbound::Frame(frame)) => {
                                // A pooled connection carries more frames. It
                                // must not keep a stopped node alive.
                                let weak = Arc::downgrade(&node);
                                tokio::spawn(handle_frame(node, frame));
                                loop {
                                    match read_next_frame(&mut stream).await {
                                        Ok(Some(frame)) => {
                                            let Some(node) = weak.upgrade() else { break };
                                            tokio::spawn(handle_frame(node, frame));
                                        }
                                        Ok(None) => break,
                                        Err(e) => {
                                            debug!(%peer, error = %e, "cluster connection closed");
                                            break;
                                        }
                                    }
                                }
                            }
                            Ok(Inbound::Snapshot(header, data)) => {
                                handle_snapshot(node, header, data).await;
                            }
                            Ok(Inbound::Rpc(request)) => {
                                handle_rpc(node, request, &mut stream).await;
                            }
                            Err(e) => warn!(%peer, error = %e, "rejected cluster connection"),
                        }
                    });
                }
                Err(e) => warn!(error = %e, "cluster accept failed"),
            },
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    break;
                }
            }
        }
    }
    // Delivered before returning, over connections of their own.
    let leaving: Vec<JoinHandle<()>> = node
        .with_membership(|m, now| m.leave(now))
        .unwrap_or_default()
        .into_iter()
        .map(|o| tokio::spawn(send_direct(o.addr, encode(&Frame::Membership(o.message)))))
        .collect();
    for handle in leaving {
        let _ = handle.await;
    }
    info!("left the cluster");
}

#[cfg(test)]
mod tests {
    use celeris_cluster::{MemberDigest, MemberState};

    use super::*;

    fn membership_frame() -> Frame {
        Frame::Membership(Message::Join {
            member: MemberDigest {
                id: NodeId::new("n1").expect("id"),
                addr: "127.0.0.1:7000".into(),
                zone: "z1".into(),
                incarnation: 4,
                state: MemberState::Alive,
            },
        })
    }

    fn raft_frame() -> Frame {
        Frame::Raft {
            from: NodeId::new("n2").expect("id"),
            message: RaftMessage::RequestVote {
                term: 3,
                last_log_index: 7,
                last_log_term: 2,
            },
        }
    }

    #[tokio::test]
    async fn frames_round_trip() {
        for frame in [membership_frame(), raft_frame()] {
            let bytes = encode(&frame);
            assert_eq!(&bytes[..4], b"CLRS");
            assert_eq!(bytes[4], FRAME_VERSION);
            assert_eq!(
                read_frame(&mut bytes.as_slice()).await.expect("decode"),
                frame
            );
        }
    }

    #[tokio::test]
    async fn snapshot_streams_round_trip_and_reject_bad_input() {
        let header = SnapshotHeader {
            group: "a+b+c".into(),
            from: NodeId::new("a").expect("id"),
            term: 4,
            last_included_index: 99,
            last_included_term: 3,
        };
        let data = vec![7u8; 3000];
        let bytes = encode_snapshot(&header, &data).expect("encode");
        assert_eq!(&bytes[..4], SNAPSHOT_MAGIC);
        let (h, d) = read_snapshot(&mut &bytes[4..]).await.expect("decode");
        assert_eq!((h, d), (header.clone(), data));

        let mut future = bytes.clone();
        future[4] = 9;
        assert!(read_snapshot(&mut &future[4..]).await.is_err());
        let mut huge = bytes.clone();
        let data_len_at = bytes.len() - 3000 - 8;
        huge[data_len_at..data_len_at + 8].copy_from_slice(&u64::MAX.to_be_bytes());
        assert!(read_snapshot(&mut &huge[4..]).await.is_err());
        assert!(
            read_snapshot(&mut &bytes[4..bytes.len() - 1])
                .await
                .is_err(),
            "truncated data"
        );
    }

    #[tokio::test]
    async fn rejects_foreign_oversized_old_and_future_frames() {
        let mut http: &[u8] = b"GET / HTTP/1.1\r\n\r\n";
        assert!(read_frame(&mut http).await.is_err());

        for version in [1u8, 9] {
            let mut other = encode(&raft_frame());
            other[4] = version;
            assert!(read_frame(&mut other.as_slice()).await.is_err());
        }

        let mut huge = encode(&raft_frame());
        huge[5..9].copy_from_slice(&u32::MAX.to_be_bytes());
        assert!(read_frame(&mut huge.as_slice()).await.is_err());

        let truncated = encode(&raft_frame());
        assert!(
            read_frame(&mut &truncated[..truncated.len() - 3])
                .await
                .is_err()
        );
    }
}
