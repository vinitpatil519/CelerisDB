//! Mutual TLS on the cluster port (D-033).
//!
//! With `cluster.tls` configured, every node-to-node connection is TLS 1.2+
//! in both directions: a node accepts only peers whose certificate chains
//! to the cluster CA, and it checks that the peer it dials presents a
//! certificate for the address it dialed (the peer's `cluster.advertise`
//! host). Without it, the cluster port is plain TCP.

use std::fs;
use std::io;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;

use anyhow::{Context, bail};
use rustls::server::WebPkiClientVerifier;
use rustls::{ClientConfig, RootCertStore, ServerConfig};
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio_rustls::{TlsAcceptor, TlsConnector};

/// A cluster connection: plain TCP or TLS.
pub(crate) trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}
pub(crate) type Conn = Pin<Box<dyn Stream>>;

/// Client and server TLS configuration of one node's cluster port.
pub struct ClusterTls {
    connector: TlsConnector,
    acceptor: TlsAcceptor,
}

impl std::fmt::Debug for ClusterTls {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ClusterTls")
    }
}

impl ClusterTls {
    pub fn from_files(cert: &Path, key: &Path, ca: &Path) -> anyhow::Result<ClusterTls> {
        let read = |p: &Path, what: &str| {
            fs::read(p).with_context(|| format!("reading cluster TLS {what} {}", p.display()))
        };
        ClusterTls::from_pem(
            &read(cert, "certificate")?,
            &read(key, "key")?,
            &read(ca, "CA")?,
        )
    }

    pub fn from_pem(cert_pem: &[u8], key_pem: &[u8], ca_pem: &[u8]) -> anyhow::Result<ClusterTls> {
        let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_slice_iter(cert_pem)
            .collect::<Result<_, _>>()
            .context("parsing the cluster certificate chain")?;
        if certs.is_empty() {
            bail!("the cluster certificate file contains no certificate");
        }
        let key = PrivateKeyDer::from_pem_slice(key_pem).context("parsing the cluster key")?;
        let mut roots = RootCertStore::empty();
        for ca in CertificateDer::pem_slice_iter(ca_pem) {
            roots
                .add(ca.context("parsing the cluster CA")?)
                .context("adding the cluster CA")?;
        }
        if roots.is_empty() {
            bail!("the cluster CA file contains no certificate");
        }
        let roots = Arc::new(roots);
        let provider = Arc::new(rustls::crypto::ring::default_provider());

        let verifier =
            WebPkiClientVerifier::builder_with_provider(Arc::clone(&roots), Arc::clone(&provider))
                .build()
                .context("building the peer certificate verifier")?;
        let server = ServerConfig::builder_with_provider(Arc::clone(&provider))
            .with_safe_default_protocol_versions()
            .context("choosing TLS versions")?
            .with_client_cert_verifier(verifier)
            .with_single_cert(certs.clone(), key.clone_key())
            .context("the cluster key does not match its certificate")?;
        let client = ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .context("choosing TLS versions")?
            .with_root_certificates(roots)
            .with_client_auth_cert(certs, key)
            .context("the cluster key does not match its certificate")?;
        Ok(ClusterTls {
            connector: TlsConnector::from(Arc::new(client)),
            acceptor: TlsAcceptor::from(Arc::new(server)),
        })
    }
}

/// The TLS server name for a `host:port` address: an IP or a DNS name.
fn server_name(addr: &str) -> io::Result<ServerName<'static>> {
    let host = match addr.parse::<std::net::SocketAddr>() {
        Ok(sa) => return Ok(ServerName::IpAddress(sa.ip().into())),
        Err(_) => addr.rsplit_once(':').map_or(addr, |(h, _)| h),
    };
    ServerName::try_from(host.trim_matches(['[', ']']).to_owned())
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))
}

/// How a node reaches its peers: TLS settings, plus peers it must not
/// reach (fault injection for tests, see [`crate::Node::isolate_from`]).
#[derive(Debug, Clone, Default)]
pub(crate) struct Dialer {
    tls: Option<Arc<ClusterTls>>,
    blocked: Arc<std::sync::RwLock<std::collections::HashSet<String>>>,
}

impl Dialer {
    pub(crate) fn new(tls: Option<ClusterTls>) -> Dialer {
        Dialer {
            tls: tls.map(Arc::new),
            blocked: Arc::default(),
        }
    }

    /// Identifies this node's way of dialing: pooled connections are never
    /// shared between nodes in one process (tests), TLS modes, or
    /// isolation sets.
    pub(crate) fn pool_key(&self, addr: &str) -> String {
        format!(
            "{:p}/{}/{addr}",
            Arc::as_ptr(&self.blocked),
            if self.tls.is_some() { "tls" } else { "tcp" }
        )
    }

    pub(crate) fn is_blocked(&self, addr: &str) -> bool {
        self.blocked
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains(addr)
    }

    pub(crate) fn set_blocked(&self, addrs: impl IntoIterator<Item = String>) {
        *self
            .blocked
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = addrs.into_iter().collect();
    }
}

/// Dials a peer's cluster port.
pub(crate) async fn connect(dialer: &Dialer, addr: &str) -> io::Result<Conn> {
    if dialer.is_blocked(addr) {
        return Err(io::Error::new(
            io::ErrorKind::ConnectionRefused,
            "peer is isolated by fault injection",
        ));
    }
    let tcp = TcpStream::connect(addr).await?;
    let _ = tcp.set_nodelay(true);
    match dialer.tls.as_deref() {
        None => Ok(Box::pin(tcp)),
        Some(t) => Ok(Box::pin(
            t.connector.connect(server_name(addr)?, tcp).await?,
        )),
    }
}

/// Completes an inbound connection (the TLS handshake, when configured).
pub(crate) async fn accept(dialer: &Dialer, tcp: TcpStream) -> io::Result<Conn> {
    match dialer.tls.as_deref() {
        None => Ok(Box::pin(tcp)),
        Some(t) => Ok(Box::pin(t.acceptor.accept(tcp).await?)),
    }
}
