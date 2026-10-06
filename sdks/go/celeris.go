// Package celeris is a Go client for the Celeris distributed key-value /
// document database.
//
// Guarantees the client keeps:
//
//   - Every write carries a mutation ID. Retries (after connection failures,
//     redirects, or errors that guarantee nothing was applied) reuse it, so a
//     write is never applied twice.
//   - A write whose outcome cannot be determined returns an
//     *OutcomeUnknownError carrying the mutation ID. Resolve it with
//     Client.MutationStatus.
//   - Every result reports the consistency the server applied. The client
//     never weakens a requested mode.
package celeris

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Consistency is a per-request consistency mode. See docs/CONSISTENCY.md.
type Consistency string

const (
	Strict    Consistency = "strict"
	Session   Consistency = "session"
	Bounded   Consistency = "bounded"
	Available Consistency = "available"
	Eventual  Consistency = "eventual"
)

const (
	SessionHeader  = "celeris-session-index"
	MutationHeader = "celeris-mutation-id"
)

// Error codes after which the same request may go to another node.
var redirects = map[string]bool{"not_leader": true, "not_owner": true, "partition_moved": true}

// 503 codes that guarantee nothing was applied: retry shortly.
var transient = map[string]bool{
	"proposal_lost":    true,
	"partition_moving": true,
	"read_retry":       true,
	"read_timeout":     true,
	"session_behind":   true,
	"no_partition_map": true,
	"epoch_ahead":      true,
}

// Error is an error answered by a node.
type Error struct {
	Status  int
	Code    string
	Message string
	// Outcome is "not_applied", "unknown" or "" (writes only).
	Outcome string
	Details map[string]any
}

func (e *Error) Error() string { return fmt.Sprintf("%d %s: %s", e.Status, e.Code, e.Message) }

// OutcomeUnknownError means a write may or may not have committed.
type OutcomeUnknownError struct {
	MutationID string
	Reason     string
}

func (e *OutcomeUnknownError) Error() string {
	return fmt.Sprintf("outcome unknown for mutation %s: %s", e.MutationID, e.Reason)
}

// ErrUnreachable means no node could be reached. For writes, nothing was applied.
var ErrUnreachable = errors.New("celeris: no node answered")

// ErrInvalidKey is returned for keys that cannot be addressed over HTTP.
var ErrInvalidKey = errors.New("celeris: keys with `.` or `..` path segments cannot be used over HTTP")

// IsCode reports whether err is a node error with the given code.
func IsCode(err error, code string) bool {
	var e *Error
	return errors.As(err, &e) && e.Code == code
}

// Item is a stored value.
type Item struct {
	Key         string
	Value       json.RawMessage
	Version     uint64
	ExpiresAtMs *uint64
	// Consistency the server applied.
	Consistency string
}

// Decode unmarshals the value into v.
func (i *Item) Decode(v any) error { return json.Unmarshal(i.Value, v) }

// WriteResult describes a successful write.
type WriteResult struct {
	Key string
	// Version is nil while an available write is pending.
	Version    *uint64
	MutationID string
	// Deduplicated: this mutation ID had already committed.
	Deduplicated bool
	// Replicated is false when an available write was accepted but not yet replicated.
	Replicated  bool
	Consistency string
}

type ReadOptions struct {
	Consistency    Consistency
	MaxStalenessMs uint64
}

type PutOptions struct {
	Consistency Consistency
	TTLMs       uint64
	// IfVersion: write only if the current version equals this.
	IfVersion *uint64
	// IfAbsent: write only if the key does not exist.
	IfAbsent bool
	// MutationID reuses an ID to retry a write safely. Default: random.
	MutationID string
}

type DeleteOptions struct {
	Consistency Consistency
	IfVersion   *uint64
	MutationID  string
}

type WriteOptions struct {
	Consistency Consistency
	MutationID  string
}

// BatchOp is one operation of an atomic batch.
type BatchOp struct {
	Op        string  `json:"op"`
	Key       string  `json:"key"`
	Value     any     `json:"value,omitempty"`
	TTLMs     uint64  `json:"ttl_ms,omitempty"`
	IfVersion *uint64 `json:"if_version,omitempty"`
	IfAbsent  bool    `json:"if_absent,omitempty"`
}

// Put is an unconditional batch put.
func Put(key string, value any) BatchOp { return BatchOp{Op: "put", Key: key, Value: value} }

// Delete is an unconditional batch delete.
func Delete(key string) BatchOp { return BatchOp{Op: "delete", Key: key} }

type ScanOptions struct {
	Prefix string
	// Start is inclusive, End exclusive.
	Start, End  string
	Limit       int
	Consistency Consistency
}

type ScanPage struct {
	Items      []Item
	NextCursor string
	// Partial: some data may be missing (unreachable replica sets).
	Partial bool
}

// QueryOptions describes a filtered query, evaluated on the server.
type QueryOptions struct {
	// Key range, page size and consistency, as for scans.
	ScanOptions
	// Where is a MongoDB-style filter, e.g.
	// map[string]any{"status": "paid", "total": map[string]any{"$gte": 100}}.
	// Operators: $eq $ne $gt $gte $lt $lte $in $nin $exists $prefix
	// $contains, combined with $and, $or and $not.
	Where map[string]any
	// Fields returns only these fields (dotted paths).
	Fields []string
	// MaxScanned caps the rows each request reads (server default 10000).
	MaxScanned int
}

// QueryPage is one page of a query. NextCursor is set while the range is
// not done, even when the page holds few items.
type QueryPage struct {
	ScanPage
	// Scanned is the number of rows the server read, matching or not.
	Scanned uint64
	// Index is the secondary index that served the page ("" for a scan).
	Index string
}

// Conflict is a write that lost last-writer-wins under available consistency.
type Conflict struct {
	Key               string  `json:"key"`
	Value             *string `json:"value"`
	TimestampMs       uint64  `json:"timestamp_ms"`
	MutationID        string  `json:"mutation_id"`
	Origin            *string `json:"origin"`
	WinnerVersion     *uint64 `json:"winner_version"`
	WinnerTimestampMs uint64  `json:"winner_timestamp_ms"`
	WinnerMutationID  string  `json:"winner_mutation_id"`
}

// Options configures a Client.
type Options struct {
	// Nodes are base URLs, e.g. http://localhost:8080.
	Nodes []string
	// Consistency is the default for reads and writes (server default: strict).
	Consistency Consistency
	// Timeout per request. Default 10 s.
	Timeout time.Duration
	// Attempts per request across nodes and transient errors. Default 4.
	Attempts int
	// Token is an API token, sent as "Authorization: Bearer <token>".
	Token string
	// Headers are added to every request.
	Headers map[string]string
	// HTTPClient overrides the HTTP client.
	HTTPClient *http.Client
}

// Client is safe for concurrent use.
type Client struct {
	nodes       []string
	consistency Consistency
	attempts    int
	headers     map[string]string
	http        *http.Client

	mu        sync.Mutex
	preferred int
	session   string
}

// New creates a client.
func New(opts Options) (*Client, error) {
	if len(opts.Nodes) == 0 {
		return nil, errors.New("celeris: at least one node URL is required")
	}
	c := &Client{
		consistency: opts.Consistency,
		attempts:    opts.Attempts,
		headers:     map[string]string{},
		http:        opts.HTTPClient,
	}
	for k, v := range opts.Headers {
		c.headers[k] = v
	}
	if opts.Token != "" {
		c.headers["Authorization"] = "Bearer " + opts.Token
	}
	for _, n := range opts.Nodes {
		n = strings.TrimRight(n, "/")
		if !strings.HasPrefix(n, "http://") && !strings.HasPrefix(n, "https://") {
			n = "http://" + n
		}
		c.nodes = append(c.nodes, n)
	}
	if c.attempts <= 0 {
		c.attempts = 4
	}
	if c.http == nil {
		timeout := opts.Timeout
		if timeout == 0 {
			timeout = 10 * time.Second
		}
		c.http = &http.Client{Timeout: timeout}
	}
	return c, nil
}

// Session is the token from the latest write or read (<index>@<group>).
func (c *Client) Session() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.session
}

func (c *Client) mode(requested Consistency) Consistency {
	if requested != "" {
		return requested
	}
	return c.consistency
}

// EncodeKey percent-encodes a key for a URL path, keeping "/" readable.
func EncodeKey(key string) (string, error) {
	segments := strings.Split(key, "/")
	for i, s := range segments {
		if s == "." || s == ".." {
			return "", ErrInvalidKey
		}
		segments[i] = url.PathEscape(s)
	}
	return strings.Join(segments, "/"), nil
}

type query []string

func (q *query) add(k, v string) {
	if v != "" {
		*q = append(*q, k+"="+url.QueryEscape(v))
	}
}

func (q query) String() string {
	if len(q) == 0 {
		return ""
	}
	return "?" + strings.Join(q, "&")
}

func u64(v uint64) string {
	if v == 0 {
		return ""
	}
	return strconv.FormatUint(v, 10)
}

func optU64(v *uint64) string {
	if v == nil {
		return ""
	}
	return strconv.FormatUint(*v, 10)
}

// Get reads a key. It returns (nil, nil) if the key does not exist.
func (c *Client) Get(ctx context.Context, key string, opts *ReadOptions) (*Item, error) {
	if opts == nil {
		opts = &ReadOptions{}
	}
	enc, err := EncodeKey(key)
	if err != nil {
		return nil, err
	}
	mode := c.mode(opts.Consistency)
	headers := map[string]string{}
	if token := c.Session(); mode == Session && token != "" {
		headers[SessionHeader] = token
	}
	var q query
	q.add("consistency", string(mode))
	q.add("max_staleness_ms", u64(opts.MaxStalenessMs))
	raw, err := c.read(ctx, http.MethodGet, "/v1/kv/"+enc+q.String(), headers)
	if err != nil {
		return nil, err
	}
	if raw.status == http.StatusNotFound {
		return nil, nil
	}
	if err := raw.ok(); err != nil {
		return nil, err
	}
	return decodeItem(raw.body, "")
}

// Put writes a JSON-serializable value.
func (c *Client) Put(ctx context.Context, key string, value any, opts *PutOptions) (*WriteResult, error) {
	if opts == nil {
		opts = &PutOptions{}
	}
	enc, err := EncodeKey(key)
	if err != nil {
		return nil, err
	}
	body, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var q query
	q.add("consistency", string(c.mode(opts.Consistency)))
	q.add("ttl_ms", u64(opts.TTLMs))
	q.add("if_version", optU64(opts.IfVersion))
	if opts.IfAbsent {
		q.add("if_absent", "true")
	}
	return c.write(ctx, http.MethodPut, "/v1/kv/"+enc+q.String(), body, opts.MutationID)
}

// Delete deletes a key. Deleting an absent key succeeds.
func (c *Client) Delete(ctx context.Context, key string, opts *DeleteOptions) (*WriteResult, error) {
	if opts == nil {
		opts = &DeleteOptions{}
	}
	enc, err := EncodeKey(key)
	if err != nil {
		return nil, err
	}
	var q query
	q.add("consistency", string(c.mode(opts.Consistency)))
	q.add("if_version", optU64(opts.IfVersion))
	return c.write(ctx, http.MethodDelete, "/v1/kv/"+enc+q.String(), nil, opts.MutationID)
}

// Batch applies operations atomically under one mutation ID.
func (c *Client) Batch(ctx context.Context, ops []BatchOp, opts *WriteOptions) (*WriteResult, error) {
	if opts == nil {
		opts = &WriteOptions{}
	}
	id := opts.MutationID
	if id == "" {
		id = newUUID()
	}
	payload := map[string]any{"mutation_id": id, "ops": ops}
	if mode := c.mode(opts.Consistency); mode != "" {
		payload["consistency"] = mode
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	return c.write(ctx, http.MethodPost, "/v1/batch", body, id)
}

// ScanPage reads one page. Pass after = the previous page's NextCursor.
func (c *Client) ScanPage(ctx context.Context, opts *ScanOptions, after string) (*ScanPage, error) {
	if opts == nil {
		opts = &ScanOptions{}
	}
	var q query
	q.add("prefix", opts.Prefix)
	q.add("start", opts.Start)
	q.add("end", opts.End)
	if opts.Limit > 0 {
		q.add("limit", strconv.Itoa(opts.Limit))
	}
	q.add("consistency", string(c.mode(opts.Consistency)))
	q.add("after", after)
	raw, err := c.read(ctx, http.MethodGet, "/v1/scan"+q.String(), nil)
	if err != nil {
		return nil, err
	}
	if err := raw.ok(); err != nil {
		return nil, err
	}
	var page struct {
		Items       []json.RawMessage `json:"items"`
		NextCursor  *string           `json:"next_cursor"`
		Partial     bool              `json:"partial"`
		Consistency string            `json:"consistency"`
	}
	if err := json.Unmarshal(raw.body, &page); err != nil {
		return nil, err
	}
	out := &ScanPage{Partial: page.Partial}
	if page.NextCursor != nil {
		out.NextCursor = *page.NextCursor
	}
	for _, i := range page.Items {
		item, err := decodeItem(i, page.Consistency)
		if err != nil {
			return nil, err
		}
		out.Items = append(out.Items, *item)
	}
	return out, nil
}

// Scan calls fn for every item in key order, fetching pages as needed.
// Returning false from fn stops the scan.
func (c *Client) Scan(ctx context.Context, opts *ScanOptions, fn func(Item) bool) error {
	after := ""
	for {
		page, err := c.ScanPage(ctx, opts, after)
		if err != nil {
			return err
		}
		for _, item := range page.Items {
			if !fn(item) {
				return nil
			}
		}
		if page.NextCursor == "" {
			return nil
		}
		after = page.NextCursor
	}
}

// QueryPage returns one page of a filtered query. Pass the previous page's
// NextCursor as after.
func (c *Client) QueryPage(ctx context.Context, opts *QueryOptions, after string) (*QueryPage, error) {
	if opts == nil {
		opts = &QueryOptions{}
	}
	req := map[string]any{}
	set := func(k, v string) {
		if v != "" {
			req[k] = v
		}
	}
	set("prefix", opts.Prefix)
	set("start", opts.Start)
	set("end", opts.End)
	set("consistency", string(c.mode(opts.Consistency)))
	set("after", after)
	if opts.Limit > 0 {
		req["limit"] = opts.Limit
	}
	if opts.MaxScanned > 0 {
		req["max_scanned"] = opts.MaxScanned
	}
	if opts.Where != nil {
		req["where"] = opts.Where
	}
	if len(opts.Fields) > 0 {
		req["fields"] = opts.Fields
	}
	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	raw, err := c.readBody(ctx, http.MethodPost, "/v1/query", nil, body)
	if err != nil {
		return nil, err
	}
	if err := raw.ok(); err != nil {
		return nil, err
	}
	var page struct {
		Items       []json.RawMessage `json:"items"`
		NextCursor  *string           `json:"next_cursor"`
		Partial     bool              `json:"partial"`
		Scanned     uint64            `json:"scanned"`
		Index       *string           `json:"index"`
		Consistency string            `json:"consistency"`
	}
	if err := json.Unmarshal(raw.body, &page); err != nil {
		return nil, err
	}
	out := &QueryPage{ScanPage: ScanPage{Partial: page.Partial}, Scanned: page.Scanned}
	if page.Index != nil {
		out.Index = *page.Index
	}
	if page.NextCursor != nil {
		out.NextCursor = *page.NextCursor
	}
	for _, i := range page.Items {
		item, err := decodeItem(i, page.Consistency)
		if err != nil {
			return nil, err
		}
		out.Items = append(out.Items, *item)
	}
	return out, nil
}

// Query calls fn for every matching item in key order, fetching pages as
// needed. Returning false from fn stops the query.
func (c *Client) Query(ctx context.Context, opts *QueryOptions, fn func(Item) bool) error {
	after := ""
	for {
		page, err := c.QueryPage(ctx, opts, after)
		if err != nil {
			return err
		}
		for _, item := range page.Items {
			if !fn(item) {
				return nil
			}
		}
		if page.NextCursor == "" {
			return nil
		}
		after = page.NextCursor
	}
}

// MutationStatus reports whether a mutation committed (within the server's
// retention window), and its version.
func (c *Client) MutationStatus(ctx context.Context, mutationID string) (committed bool, version *uint64, err error) {
	raw, err := c.read(ctx, http.MethodGet, "/v1/mutations/"+url.PathEscape(mutationID), nil)
	if err != nil {
		return false, nil, err
	}
	if raw.status == http.StatusNotFound {
		return false, nil, nil
	}
	if err := raw.ok(); err != nil {
		return false, nil, err
	}
	var body struct {
		Version *uint64 `json:"version"`
	}
	if err := json.Unmarshal(raw.body, &body); err != nil {
		return false, nil, err
	}
	return true, body.Version, nil
}

// Conflicts lists writes that lost last-writer-wins under available consistency.
func (c *Client) Conflicts(ctx context.Context, prefix string, limit int) (conflicts []Conflict, partial bool, err error) {
	var q query
	q.add("prefix", prefix)
	if limit > 0 {
		q.add("limit", strconv.Itoa(limit))
	}
	raw, err := c.read(ctx, http.MethodGet, "/v1/conflicts"+q.String(), nil)
	if err != nil {
		return nil, false, err
	}
	if err := raw.ok(); err != nil {
		return nil, false, err
	}
	var body struct {
		Conflicts []Conflict `json:"conflicts"`
		Partial   bool       `json:"partial"`
	}
	if err := json.Unmarshal(raw.body, &body); err != nil {
		return nil, false, err
	}
	return body.Conflicts, body.Partial, nil
}

// ClearConflicts forgets the recorded conflicts of a key.
func (c *Client) ClearConflicts(ctx context.Context, key string) error {
	enc, err := EncodeKey(key)
	if err != nil {
		return err
	}
	raw, err := c.read(ctx, http.MethodDelete, "/v1/conflicts/"+enc, nil)
	if err != nil {
		return err
	}
	return raw.ok()
}

// Status returns node, cluster and storage status.
func (c *Client) Status(ctx context.Context) (map[string]any, error) {
	raw, err := c.read(ctx, http.MethodGet, "/v1/status", nil)
	if err != nil {
		return nil, err
	}
	if err := raw.ok(); err != nil {
		return nil, err
	}
	var out map[string]any
	return out, json.Unmarshal(raw.body, &out)
}

// -- transport ---------------------------------------------------------------

type rawResponse struct {
	status  int
	body    []byte
	session string
	err     map[string]any
}

func (r *rawResponse) code() string {
	if s, ok := r.err["code"].(string); ok {
		return s
	}
	return ""
}

func (r *rawResponse) retryable() bool {
	return (r.status == 421 && redirects[r.code()]) || (r.status == 503 && transient[r.code()])
}

func (r *rawResponse) apiError() *Error {
	e := &Error{Status: r.status, Code: r.code(), Details: r.err}
	if e.Code == "" {
		e.Code = "http_error"
	}
	if m, ok := r.err["message"].(string); ok {
		e.Message = m
	} else {
		e.Message = fmt.Sprintf("HTTP %d", r.status)
	}
	if o, ok := r.err["outcome"].(string); ok && (o == "not_applied" || o == "unknown") {
		e.Outcome = o
	}
	return e
}

func (r *rawResponse) ok() error {
	if r.status >= 200 && r.status < 300 {
		return nil
	}
	return r.apiError()
}

// errNotSent marks a failure before the connection was established.
type errNotSent struct{ err error }

func (e errNotSent) Error() string { return e.err.Error() }

func (c *Client) send(ctx context.Context, node int, method, path string, headers map[string]string, body []byte) (*rawResponse, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.nodes[node]+path, reader)
	if err != nil {
		return nil, errNotSent{err}
	}
	req.Header.Set("content-type", "application/json")
	for k, v := range c.headers {
		req.Header.Set(k, v)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		var op *net.OpError
		if errors.As(err, &op) && op.Op == "dial" {
			return nil, errNotSent{err}
		}
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	raw := &rawResponse{status: resp.StatusCode, body: data, session: resp.Header.Get(SessionHeader)}
	if resp.StatusCode >= 300 {
		var wrapper struct {
			Error map[string]any `json:"error"`
		}
		if json.Unmarshal(data, &wrapper) == nil && wrapper.Error != nil {
			raw.err = wrapper.Error
		} else {
			raw.err = map[string]any{"code": "invalid_response", "message": string(data)}
		}
	}
	return raw, nil
}

func (c *Client) start() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.preferred
}

func (c *Client) remember(node int, raw *rawResponse) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.preferred = node
	if raw.session != "" {
		c.session = raw.session
	}
}

func backoff(ctx context.Context, attempt int, base time.Duration) error {
	t := time.NewTimer(base * time.Duration(attempt+1))
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// read sends idempotent calls, retried on any failure.
func (c *Client) read(ctx context.Context, method, path string, headers map[string]string) (*rawResponse, error) {
	return c.readBody(ctx, method, path, headers, nil)
}

func (c *Client) readBody(ctx context.Context, method, path string, headers map[string]string, body []byte) (*rawResponse, error) {
	start := c.start()
	var last error
	for attempt := 0; attempt < c.attempts; attempt++ {
		node := (start + attempt) % len(c.nodes)
		raw, err := c.send(ctx, node, method, path, headers, body)
		switch {
		case err != nil:
			last = fmt.Errorf("%w: %v", ErrUnreachable, err)
		case raw.retryable():
			last = raw.apiError()
		default:
			c.remember(node, raw)
			return raw, nil
		}
		if err := backoff(ctx, attempt, 50*time.Millisecond); err != nil {
			return nil, err
		}
	}
	return nil, last
}

// write retries with the same mutation ID after network failures (the
// server deduplicates), on another node after redirects, and after errors
// that guarantee nothing was applied.
func (c *Client) write(ctx context.Context, method, path string, body []byte, mutationID string) (*WriteResult, error) {
	if mutationID == "" {
		mutationID = newUUID()
	}
	headers := map[string]string{MutationHeader: mutationID}
	start := c.start()
	maybeSent := false
	var last error
	for attempt := 0; attempt < c.attempts; attempt++ {
		node := (start + attempt) % len(c.nodes)
		raw, err := c.send(ctx, node, method, path, headers, body)
		var notSent errNotSent
		switch {
		case errors.As(err, &notSent):
			last = fmt.Errorf("%w: %v", ErrUnreachable, err)
		case err != nil:
			maybeSent = true
			last = err
		case raw.retryable():
			last = raw.apiError()
			if raw.status == 421 {
				continue
			}
		case raw.err["outcome"] == "unknown":
			// Retrying with the same ID is safe and may resolve it.
			maybeSent = true
			last = raw.apiError()
		default:
			if err := raw.ok(); err != nil {
				return nil, err
			}
			c.remember(node, raw)
			var b struct {
				Key          string  `json:"key"`
				Version      *uint64 `json:"version"`
				MutationID   string  `json:"mutation_id"`
				Deduplicated bool    `json:"deduplicated"`
				Consistency  string  `json:"consistency"`
			}
			if err := json.Unmarshal(raw.body, &b); err != nil {
				return nil, err
			}
			if b.MutationID == "" {
				b.MutationID = mutationID
			}
			return &WriteResult{
				Key:          b.Key,
				Version:      b.Version,
				MutationID:   b.MutationID,
				Deduplicated: b.Deduplicated,
				Replicated:   raw.status != http.StatusAccepted,
				Consistency:  b.Consistency,
			}, nil
		}
		if err := backoff(ctx, attempt, 100*time.Millisecond); err != nil {
			if maybeSent {
				return nil, &OutcomeUnknownError{MutationID: mutationID, Reason: err.Error()}
			}
			return nil, err
		}
	}
	if maybeSent {
		return nil, &OutcomeUnknownError{
			MutationID: mutationID,
			Reason:     fmt.Sprintf("no confirmation after %d attempts: %v", c.attempts, last),
		}
	}
	return nil, last
}

func decodeItem(data []byte, consistency string) (*Item, error) {
	var b struct {
		Key         string          `json:"key"`
		Value       json.RawMessage `json:"value"`
		Version     uint64          `json:"version"`
		ExpiresAtMs *uint64         `json:"expires_at_ms"`
		Consistency string          `json:"consistency"`
	}
	if err := json.Unmarshal(data, &b); err != nil {
		return nil, err
	}
	if consistency == "" {
		consistency = b.Consistency
	}
	return &Item{Key: b.Key, Value: b.Value, Version: b.Version, ExpiresAtMs: b.ExpiresAtMs, Consistency: consistency}, nil
}

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
