# 4. Server-Sent Events, fanned out through Redis pub/sub

Date: 2026-11-22
Status: Accepted

## Context
Viewers need accepted bids and the close pushed to them within about a second. Bids themselves go over plain HTTP POST, so they get status codes, idempotency headers and simple retries. That makes live traffic one-way, server to client. The server runs as two or more instances, and a bid accepted on one must reach viewers connected to another.

## Options considered
1. **WebSockets.** Two-way and widely recognized, but nothing here needs client-to-server messages over the socket. It brings its own reconnect, heartbeat and proxy handling.
2. **Server-Sent Events.** One-way over HTTP, with automatic reconnection and `Last-Event-ID` resume built into browsers. It works through ordinary proxies. Text only, which is fine for JSON.
3. **Polling.** Trivial, but it's either laggy or wasteful, and it doesn't show real-time skill.
4. **A hosted pub/sub service (Ably, Pusher).** Least code, but it outsources the part the project should prove.

For cross-instance fan-out:
- **Redis pub/sub:** every instance subscribes. Fire-and-forget, so missed messages are recovered by snapshot and resume.
- **Postgres `LISTEN/NOTIFY`:** no extra service, but it doesn't work through transaction-mode connection poolers (which hosted Postgres tiers often put in front), and every instance holds a dedicated connection.

## Decision
SSE for delivery, Redis pub/sub for fan-out between instances. Every event carries the auction `version` as its SSE id. On connect or reconnect, the client gets a snapshot from Postgres, then only events with a higher version.

## Why
SSE matches the traffic's direction and gets reconnection for free. Redis is the standard way to fan out across instances and is a skill the roadmap wants proven. Postgres stays the only source of truth, so losing a Redis message costs a moment of staleness, never correctness.

## Consequences
- Answer for interviews: "why not WebSockets?" is answered here.
- The host must allow long-lived HTTP responses (spec §13, hosting).
- If the client ever needs to send messages over the live channel (chat, typing indicators), revisit with WebSockets.
