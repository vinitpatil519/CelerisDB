# Deploying Celeris

Celeris runs as one binary, `celeris`. Every node serves the HTTP API and
speaks to the other nodes on a separate cluster port.

| Port | Purpose | Expose to |
|---|---|---|
| 8080 | HTTP/JSON API, WebSocket change streams, `/metrics`, `/health`, `/ready` | clients, load balancer, Prometheus |
| 7000 | node-to-node: gossip, Raft, snapshots, migration | other nodes only |

Serve the API over HTTPS with `CELERIS_TLS_CERT` and `CELERIS_TLS_KEY`
(see [API.md](API.md#tls)).

Protect the cluster port with mutual TLS (D-033). Give every node a
certificate from a CA dedicated to the cluster, naming the host of its
`cluster.advertise` address (DNS name or IP SAN):

```toml
[cluster]
tls = { cert_file = "tls/node.crt", key_file = "tls/node.key", ca_file = "tls/cluster-ca.crt" }
```

or set `CELERIS_CLUSTER_TLS_CERT`, `CELERIS_CLUSTER_TLS_KEY` and
`CELERIS_CLUSTER_TLS_CA`. Nodes then accept only peers whose certificates
chain to that CA, and they check that each peer they dial presents a
certificate for the address they dialed. Every node of a cluster must use
it; a node without TLS cannot talk to one with it. Keep the cluster port
on a private network anyway.

## Sizing and topology

* **Voters:** 3 (or 5) control-plane voters, fixed when the cluster is
  created (`cluster.voters`). Each needs a stable node ID (`node.id`) and a
  stable cluster address (`cluster.advertise`).
* **Replication factor:** 3 by default (`cluster.replication_factor`). A
  key's replica set is a Raft group, so writes need 2 of 3 replicas.
* **Zones:** set `cluster.zone` per node (rack or availability zone).
  Placement spreads each partition's replicas across zones.
* **Disks:** `storage.sync = "always"` (the default) fsyncs every write.
  Use SSDs. Data lives in `node.data_dir`.

## Docker

```bash
docker build -t celeris .
docker run -d -p 8080:8080 -v celeris-data:/var/lib/celeris/data celeris
```

The image runs as uid 10001 under `tini`, listens on `0.0.0.0:8080`, and
keeps data in the `/var/lib/celeris/data` volume. Configure it with
`CELERIS_*` environment variables (see `celeris init` for the full list) or
mount a `celeris.toml` and run `celeris start --config /path/celeris.toml`.

## Docker Compose: a 3-node cluster

```bash
docker compose up -d --build
curl -X PUT localhost:8081/v1/kv/hello -d '"world"'
curl "localhost:8083/v1/kv/hello?consistency=eventual"
```

[`docker-compose.yml`](../docker-compose.yml) starts `node-a`, `node-b` and
`node-c` as voters in three zones, with the API on host ports 8081–8083.
Once all three are up, the control-plane leader places partitions with
three replicas (D-025). `docker compose down -v` deletes the data.

Admin endpoints (`/v1/admin/*`) accept loopback connections only. Run them
inside a container: `docker compose exec node-a celeris --addr
http://127.0.0.1:8080 cluster rebalance --rf 3`. Any voter works; followers
forward the request to the leader.

## Kubernetes

[`deploy/kubernetes/celeris.yaml`](../deploy/kubernetes/celeris.yaml) holds
a StatefulSet of three voters, a headless Service for the cluster port, a
client Service, and a PodDisruptionBudget that keeps a Raft majority up.

```bash
kubectl apply -f deploy/kubernetes/celeris.yaml
kubectl rollout status statefulset/celeris
kubectl port-forward svc/celeris 8080:8080
```

How it fits together:

* Pod names (`celeris-0`, `-1`, `-2`) are the node IDs and the voters.
* Each pod advertises `<pod>.celeris-peers.<namespace>.svc.cluster.local:7000`.
  The headless Service publishes addresses before pods are ready, so peers
  find each other while starting.
* `podManagementPolicy: Parallel` starts all voters at once. The first
  placement waits for every voter.
* Each pod gets a 10 GiB `ReadWriteOnce` volume. Adjust
  `volumeClaimTemplates` and `resources` for your workload.
* The image is `ghcr.io/vinitpatil519/celeris`. The *Container image*
  workflow publishes it when a `v*` tag is pushed. For a local cluster, build
  and load it instead:

  ```bash
  docker build -t ghcr.io/vinitpatil519/celeris:latest .
  kind load docker-image ghcr.io/vinitpatil519/celeris:latest
  ```

For mutual TLS between pods, issue each pod a certificate for
`<pod>.celeris-peers.<namespace>.svc.cluster.local` (cert-manager works
well), mount it from a Secret, and set the `CELERIS_CLUSTER_TLS_*`
variables to the mounted paths.

To spread replicas across availability zones, give each pod its zone in
`CELERIS_ZONE`. Kubernetes does not expose node labels to pods, so use one
StatefulSet per zone, or an init container that reads the node's
`topology.kubernetes.io/zone` label.

**Not supported yet:** changing `replicas` beyond the three voters adds data
nodes only after non-voter data nodes land (see the roadmap). Do not scale
the StatefulSet down below three.

## AWS reference architecture

This is a starting point, not a managed offering.

### EC2

* **Instances:** three `m7g.large` or `i4i.large` instances (Graviton or
  local NVMe), one per availability zone, in private subnets.
* **Storage:** a gp3 EBS volume per node for `node.data_dir`. Start at
  3000 IOPS and 125 MiB/s, and raise IOPS for write-heavy workloads; every
  write fsyncs. `i4i` instance-store NVMe is faster, but it is lost when the
  instance stops. Use it only with replication factor 3 and backups.
* **Networking:**
  * clients reach 8080 through an internal Network Load Balancer, with
    health checks on `/ready`;
  * a security group allows 7000 only from the group itself.
* **Identity:**
  * give each instance a fixed `node.id`, for example from its Name tag;
  * set `cluster.advertise` to its private DNS name;
  * set `cluster.zone` to its availability zone (from instance metadata).
* **Process:** run `celeris start` under systemd with `Restart=always` and
  `LimitNOFILE=65536`.

### EKS

* Use the Kubernetes manifest above with a `gp3` StorageClass
  (`volumeBindingMode: WaitForFirstConsumer`). Then each volume is created
  in its pod's zone.
* Add a `topologySpreadConstraints` entry on `topology.kubernetes.io/zone`
  to place one voter per zone.
* Expose the `celeris` Service through an internal NLB
  (`service.beta.kubernetes.io/aws-load-balancer-scheme: internal`).

### Observability

* Scrape `/metrics` with Prometheus (or Amazon Managed Prometheus).
* Logs are JSON when `CELERIS_LOG_FORMAT=json`.
* Alert on:
  * `/ready` failures (a node whose storage turned read-only);
  * Raft leader changes;
  * a growing count of conflicts recorded by `available` writes.

### Backups

* **Single node:** `celeris backup --out file` takes a consistent online
  snapshot. Copy it to S3; restore with `celeris restore` (see
  [CLI.md](CLI.md#backups)).
* **Cluster:** `celeris export` writes every key as JSON lines through the
  API, and `celeris import` loads it into any cluster. Export needs a
  `read`-scoped token, import a `write`-scoped one.
* EBS snapshots also work: snapshot all volumes at once with
  crash-consistent multi-volume snapshots. Recovery replays the
  write-ahead log.
