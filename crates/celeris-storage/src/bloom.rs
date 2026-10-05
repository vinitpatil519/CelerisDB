//! Per-SSTable bloom filter. Lets point reads skip tables that cannot hold a key.

use xxhash_rust::xxh3::xxh3_64;

use crate::codec::DecodeError;

/// Stable 64-bit key hash. Persisted indirectly (bloom bits), so it must
/// never change for a given format version.
pub(crate) fn hash_key(key: &[u8]) -> u64 {
    xxh3_64(key)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BloomFilter {
    bits: Vec<u8>,
    k: u8,
}

impl BloomFilter {
    pub(crate) fn build(key_hashes: &[u64], bits_per_key: usize) -> Self {
        let nbytes = (key_hashes.len() * bits_per_key).max(64).div_ceil(8);
        // ln(2) * bits/key minimises the false-positive rate.
        let k = ((bits_per_key as f64) * 0.69).round().clamp(1.0, 30.0) as u8;
        let mut filter = BloomFilter {
            bits: vec![0; nbytes],
            k,
        };
        let nbits = filter.nbits();
        for &h in key_hashes {
            for bit in probes(h, k, nbits) {
                filter.bits[bit / 8] |= 1 << (bit % 8);
            }
        }
        filter
    }

    fn nbits(&self) -> usize {
        self.bits.len() * 8
    }

    pub(crate) fn may_contain(&self, key: &[u8]) -> bool {
        probes(hash_key(key), self.k, self.nbits())
            .all(|bit| self.bits[bit / 8] & (1 << (bit % 8)) != 0)
    }

    pub(crate) fn encode(&self, out: &mut Vec<u8>) {
        out.push(self.k);
        out.extend_from_slice(&self.bits);
    }

    pub(crate) fn decode(buf: &[u8]) -> Result<Self, DecodeError> {
        let (&k, bits) = buf.split_first().ok_or(DecodeError("empty bloom filter"))?;
        if k == 0 || k > 30 || bits.is_empty() {
            return Err(DecodeError("malformed bloom filter"));
        }
        Ok(BloomFilter {
            bits: bits.to_vec(),
            k,
        })
    }
}

/// Double hashing: probe i is `h + i * delta (mod nbits)`.
fn probes(h: u64, k: u8, nbits: usize) -> impl Iterator<Item = usize> {
    let delta = (h >> 33) | 1;
    (0..u64::from(k)).map(move |i| (h.wrapping_add(i.wrapping_mul(delta)) % nbits as u64) as usize)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_false_negatives_and_low_false_positive_rate() {
        let keys: Vec<Vec<u8>> = (0..10_000)
            .map(|i| format!("key-{i}").into_bytes())
            .collect();
        let hashes: Vec<u64> = keys.iter().map(|k| hash_key(k)).collect();
        let filter = BloomFilter::build(&hashes, 10);
        assert!(keys.iter().all(|k| filter.may_contain(k)));
        let false_positives = (0..10_000)
            .filter(|i| filter.may_contain(format!("absent-{i}").as_bytes()))
            .count();
        // Theory: ~0.8% at 10 bits/key. Allow generous slack.
        assert!(false_positives < 300, "false positives: {false_positives}");
    }

    #[test]
    fn encode_round_trip() {
        let filter = BloomFilter::build(&[hash_key(b"a"), hash_key(b"b")], 10);
        let mut buf = Vec::new();
        filter.encode(&mut buf);
        assert_eq!(BloomFilter::decode(&buf), Ok(filter));
        assert!(BloomFilter::decode(&[]).is_err());
        assert!(BloomFilter::decode(&[0, 1, 2]).is_err());
    }
}
