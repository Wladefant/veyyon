Send and receive short text messages between the agents running in this process.

# Addressing
`Main` is the main agent; a spawned agent's ID is its task name. `op: "list"` shows each peer's status, unread count and recent activity. Use exact roster IDs; never invent names.

# Other sessions
`to: "session:<sessionId>"` reaches one Veyyon session on this machine; `to: "session:all"` reaches every other live one. The notice is stored on disk and shown when that session next takes a step or turn, with your name and both times. A notice read more than 2 hours after sending is dropped and you get a "Not delivered" notice; `ttlMinutes` sets the limit (max 1440). The receipt says `queued` and `live` or `offline`. There is no reply channel and no wake of an idle session. Use it for warnings that must not be lost, such as "VPS frozen, no docker commands". Keep the text under 8 KB.

# Sending
- `op: "send"` never blocks. The receipt says `delivered` or `failed`. A `failed` receipt means the peer is gone; do not retry.
- A send wakes an `idle` or `parked` peer, which spends a full turn reading it. `to: "all"` charges that to every peer at once.
- Plain prose only. Never send JSON. Share payloads as `local://` or `artifact://` URLs.
- Answer with the answer first. Do not quote the question. Set `replyTo`.

# Waiting
Use `op: "wait"`, or `await: true` on the send, only when you cannot proceed without the answer. It returns on a matching message, on timeout, or on any IRC or steering interrupt. `op: "inbox"` drains the queue without blocking. Do not alternate wait, inbox and job poll.

# What is worth a message
Send when the message changes what someone does:
- You are about to edit a file another agent may hold, or need one it holds. Message first, not after.
- You hit an unexpected state or a decision that is not yours. Name it to `Main` or your spawner.
- You found something that makes a peer's current work wrong or wasted. Interrupting is cheaper than letting it finish.
- A peer asked you a direct question.

# Never send
- Bare acknowledgements ("understood", "noted", "thanks", "ack"). They carry no information, and they look like traffic that deserves an ack, which is what a two-agent loop is made of. Silence is the acknowledgement.
- Progress reports, plans, restated assignments, or "starting now".
- Anything a tool can answer, including what a peer is doing. Ask the peer, or do not need to know.
- The next line of a back-and-forth. The bus refuses a pair that has traded 16 messages in a row with no one else involved.
