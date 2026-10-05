package celeris

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// ChangeEvent is one applied change.
type ChangeEvent struct {
	Key string `json:"key"`
	// Kind is "put" or "delete".
	Kind string `json:"kind"`
	// Value is the new value for puts, null for deletes.
	Value      json.RawMessage `json:"value"`
	Version    uint64          `json:"version"`
	MutationID string          `json:"mutation_id"`
}

// WatchEvent is either a change or a lagged notice.
type WatchEvent struct {
	Change *ChangeEvent
	// Lagged is the number of events the server dropped because this watcher
	// fell behind: re-read the keys you depend on.
	Lagged uint64
}

// Hello is the first message of a change stream.
type Hello struct {
	Node   string   `json:"node"`
	Prefix string   `json:"prefix"`
	Groups []string `json:"groups"`
	// Partial: this node covers only some replica sets.
	Partial bool `json:"partial"`
}

// ErrWatchClosed is returned by Watch.Next once the stream has closed.
var ErrWatchClosed = errors.New("celeris: change stream closed")

// Watch is an open change stream (best-effort, from "now"). It uses a small
// built-in WebSocket client so the package has no dependencies.
type Watch struct {
	Hello Hello

	conn      net.Conn
	reader    *bufio.Reader
	writeMu   sync.Mutex
	closeOnce sync.Once
}

const (
	opContinuation = 0x0
	opText         = 0x1
	opBinary       = 0x2
	opClose        = 0x8
	opPing         = 0x9
	opPong         = 0xA
)

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// Watch opens a change stream for keys starting with prefix on one node.
func (c *Client) Watch(ctx context.Context, prefix string) (*Watch, error) {
	base, err := url.Parse(c.nodes[c.start()%len(c.nodes)])
	if err != nil {
		return nil, err
	}
	host := base.Host
	if base.Port() == "" {
		if base.Scheme == "https" {
			host += ":443"
		} else {
			host += ":80"
		}
	}
	var dialer net.Dialer
	conn, err := dialer.DialContext(ctx, "tcp", host)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnreachable, err)
	}
	if base.Scheme == "https" {
		tlsConn := tls.Client(conn, &tls.Config{ServerName: base.Hostname()})
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			conn.Close()
			return nil, err
		}
		conn = tlsConn
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}

	var nonce [16]byte
	_, _ = rand.Read(nonce[:])
	key := base64.StdEncoding.EncodeToString(nonce[:])
	path := strings.TrimRight(base.Path, "/") + "/v1/watch?prefix=" + url.QueryEscape(prefix)
	var request strings.Builder
	fmt.Fprintf(&request, "GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n", path, base.Host)
	fmt.Fprintf(&request, "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n", key)
	for k, v := range c.headers {
		fmt.Fprintf(&request, "%s: %s\r\n", k, v)
	}
	request.WriteString("\r\n")
	if _, err := io.WriteString(conn, request.String()); err != nil {
		conn.Close()
		return nil, err
	}

	reader := bufio.NewReader(conn)
	resp, err := http.ReadResponse(reader, nil)
	if err != nil {
		conn.Close()
		return nil, err
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		resp.Body.Close()
		conn.Close()
		raw := &rawResponse{status: resp.StatusCode}
		var wrapper struct {
			Error map[string]any `json:"error"`
		}
		if json.Unmarshal(body, &wrapper) == nil {
			raw.err = wrapper.Error
		}
		return nil, raw.apiError()
	}
	sum := sha1.Sum([]byte(key + wsGUID))
	if resp.Header.Get("Sec-WebSocket-Accept") != base64.StdEncoding.EncodeToString(sum[:]) {
		conn.Close()
		return nil, errors.New("celeris: invalid Sec-WebSocket-Accept")
	}
	_ = conn.SetDeadline(time.Time{})

	w := &Watch{conn: conn, reader: reader}
	msg, err := w.message(ctx)
	if err != nil {
		w.Close()
		return nil, err
	}
	var hello struct {
		Type string `json:"type"`
		Hello
	}
	if err := json.Unmarshal(msg, &hello); err != nil || hello.Type != "hello" {
		w.Close()
		return nil, fmt.Errorf("celeris: unexpected first message: %s", msg)
	}
	w.Hello = hello.Hello
	return w, nil
}

// Next returns the next event. It returns ErrWatchClosed once the stream
// closed, or ctx.Err() if ctx ends first (the stream is then closed).
func (w *Watch) Next(ctx context.Context) (WatchEvent, error) {
	for {
		msg, err := w.message(ctx)
		if err != nil {
			return WatchEvent{}, err
		}
		var head struct {
			Type   string `json:"type"`
			Missed uint64 `json:"missed"`
		}
		if err := json.Unmarshal(msg, &head); err != nil {
			return WatchEvent{}, err
		}
		switch head.Type {
		case "change":
			var change ChangeEvent
			if err := json.Unmarshal(msg, &change); err != nil {
				return WatchEvent{}, err
			}
			return WatchEvent{Change: &change}, nil
		case "lagged":
			return WatchEvent{Lagged: head.Missed}, nil
		}
	}
}

// Close closes the stream.
func (w *Watch) Close() error {
	var err error
	w.closeOnce.Do(func() {
		_ = w.send(opClose, []byte{0x03, 0xE8}) // 1000: normal closure
		err = w.conn.Close()
	})
	return err
}

func (w *Watch) message(ctx context.Context) ([]byte, error) {
	if ctx.Done() != nil {
		stop := context.AfterFunc(ctx, func() { _ = w.conn.SetReadDeadline(time.Unix(1, 0)) })
		defer stop()
	}
	var message []byte
	for {
		fin, op, payload, err := w.frame()
		if err != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				w.Close()
				return nil, ctxErr
			}
			w.Close()
			if errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) {
				return nil, ErrWatchClosed
			}
			return nil, err
		}
		switch op {
		case opPing:
			if err := w.send(opPong, payload); err != nil {
				return nil, err
			}
		case opPong:
		case opClose:
			w.Close()
			return nil, ErrWatchClosed
		case opText, opBinary, opContinuation:
			message = append(message, payload...)
			if fin {
				return message, nil
			}
		}
	}
}

func (w *Watch) frame() (fin bool, op byte, payload []byte, err error) {
	var head [2]byte
	if _, err = io.ReadFull(w.reader, head[:]); err != nil {
		return
	}
	fin, op = head[0]&0x80 != 0, head[0]&0x0F
	length := uint64(head[1] & 0x7F)
	switch length {
	case 126:
		var ext [2]byte
		if _, err = io.ReadFull(w.reader, ext[:]); err != nil {
			return
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err = io.ReadFull(w.reader, ext[:]); err != nil {
			return
		}
		length = binary.BigEndian.Uint64(ext[:])
	}
	if length > 64<<20 {
		err = errors.New("celeris: change stream frame too large")
		return
	}
	var mask [4]byte
	masked := head[1]&0x80 != 0
	if masked {
		if _, err = io.ReadFull(w.reader, mask[:]); err != nil {
			return
		}
	}
	payload = make([]byte, length)
	if _, err = io.ReadFull(w.reader, payload); err != nil {
		return
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}
	return
}

// send writes one masked frame (client frames must be masked).
func (w *Watch) send(op byte, payload []byte) error {
	w.writeMu.Lock()
	defer w.writeMu.Unlock()
	frame := []byte{0x80 | op}
	n := len(payload)
	switch {
	case n < 126:
		frame = append(frame, 0x80|byte(n))
	case n < 65536:
		frame = append(frame, 0x80|126, byte(n>>8), byte(n))
	default:
		frame = append(frame, 0x80|127)
		frame = binary.BigEndian.AppendUint64(frame, uint64(n))
	}
	var mask [4]byte
	_, _ = rand.Read(mask[:])
	frame = append(frame, mask[:]...)
	for i, b := range payload {
		frame = append(frame, b^mask[i%4])
	}
	_, err := w.conn.Write(frame)
	return err
}
