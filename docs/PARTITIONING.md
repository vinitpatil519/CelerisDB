# Partitioning (as implemented)

Code: `crates/celeris-core/src/partition.rs`.

## Key → partition

```text
partition = xxh3_64(key, seed 0) mod 4096
```

The partition universe is fixed at **4096** for the life of a cluster.
Adding nodes moves partitions; it never re-hashes keys. The hash is a
persistent format, pinned by golden test vectors: `"users/42"` → 1118,
`"orders/123"` → 2920. Changing it would re-home every key.

## Partition → replicas: rendezvous hashing

For each partition, every node gets a score
`xxh3_64(node_id, seed = partition)`. The highest scores win:

1. Walk nodes by descending score and take one per **zone** until
   `replication_factor` replicas are chosen.
2. If there are fewer zones than replicas, fill with the next-highest nodes.
   `zone_diverse(p)` then reports `false`.
3. The first replica is the **preferred leader**.

Why rendezvous hashing:

* **Deterministic and stateless.** The map is a pure function of
  (node set, replication factor), and input order does not matter. Every
  node computes the same map without coordination.
* **Minimal movement.**
  * A joining node takes only the partitions where it now ranks in the
    top RF: about 1/N of them.
  * A leaving node gives up only its own partitions.
  * Both properties are tested; the property test checks them over random
    memberships.
* **Balanced.** With 4096 partitions, measured replica and leader counts stay
  within 10–15% of the mean (tested with 6 nodes, 3 zones, RF 3).

## Epochs and fencing

* The map has an `epoch`. Every `rebalance` produces `epoch + 1`.
* Every partition records the epoch at which its replica list last
  changed. Unchanged partitions keep their old epoch, so clients routing
  to them are not invalidated.
* `validate_epoch(p, request_epoch)` behaves as follows:
  * `request_epoch < partition_epoch` → **Stale**: the client routed with
    an old owner and must refresh.
  * `request_epoch > map epoch` → **Ahead**: this node's map is behind and
    must catch up.
  * Otherwise the request is accepted.

Fencing is enforced on the data path when multi-node replication lands (M4).

## Rebalancing

`rebalance(new_nodes, rf)` returns the new map and a list of `Move`s, one per
changed partition. Each move lists the nodes added and removed and whether
the leader changed. Data transfer for each move follows `SYSTEM_DESIGN.md`:

1. Stream a source snapshot.
2. Stream the WAL tail.
3. Verify the checksum.
4. Switch the epoch.

That transfer is milestone M4 work.

## Serialization

`PartitionMap` serializes to JSON with `format_version: 1`. Deserialization
validates every invariant and rejects maps that break them:

* partition count;
* replica-set size and distinctness;
* node indexes in range;
* sorted, unique nodes;
* epochs in range.

## Today (single node)

A node holds `PartitionMap::single_node(id)`: every partition on itself,
RF 1, epoch 1.

* `GET /v1/partitions` and `celeris partitions` show the map and per-node load.
* `GET /v1/partitions/key/{key}` and `celeris partitions --key K` show where
  a key lives.
