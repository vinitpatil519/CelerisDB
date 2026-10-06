//! HTTPS for the client API: rustls (ring provider), certificates from PEM
//! files, HTTP/2 and HTTP/1.1 via ALPN.
//!
//! The cluster port is separate and not covered here.

use std::fs;
use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, bail};
use rustls::ServerConfig;
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, PrivateKeyDer};
use tokio_rustls::TlsAcceptor;

/// Builds a TLS acceptor from a PEM certificate chain and a PEM private key
/// (PKCS#8, PKCS#1 or SEC1).
pub fn acceptor(cert_file: &Path, key_file: &Path) -> anyhow::Result<TlsAcceptor> {
    let cert_pem = fs::read(cert_file)
        .with_context(|| format!("reading TLS certificate {}", cert_file.display()))?;
    let key_pem =
        fs::read(key_file).with_context(|| format!("reading TLS key {}", key_file.display()))?;
    acceptor_from_pem(&cert_pem, &key_pem)
}

pub fn acceptor_from_pem(cert_pem: &[u8], key_pem: &[u8]) -> anyhow::Result<TlsAcceptor> {
    let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_slice_iter(cert_pem)
        .collect::<Result<_, _>>()
        .context("parsing the TLS certificate chain")?;
    if certs.is_empty() {
        bail!("the TLS certificate file contains no certificate");
    }
    let key = PrivateKeyDer::from_pem_slice(key_pem).context("parsing the TLS private key")?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .context("choosing TLS versions")?
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .context("the TLS key does not match the certificate")?;
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    Ok(TlsAcceptor::from(Arc::new(config)))
}
