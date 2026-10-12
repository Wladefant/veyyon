# Encrypted session checkpoint service

This bounded HTTP Worker stores ciphertext in R2. A SQLite Durable Object owns each session lease, committed head, replay results and index outbox. D1 is a repairable catalog, never the ownership authority.

Deploy only in account a0d288d1c95470cd009cc6e0df7accb7. This account already has Workers Paid and R2 Paid subscriptions. This deployment adds no subscription. Resources use the veyyon- prefix. No scheduled compute or Containers run here.

Clients encrypt native recovery bundles before upload. Objects are create-only and SHA-256 addressed. A commit validates every referenced object before one DO transaction publishes the head and replay result. An interrupted D1 update does not undo that commit. Reading the head repairs its index.

Limits: 8 MiB per object, 64 MiB per checkpoint, 1024 object references, 100 checkpoints per session, 100 sessions, 1 GiB total upload reservations, 10,000 daily operation units. Commit reservations include every referenced object read. A global DO enforces caps before admission. Rejected or interrupted uploads consume their reservation conservatively. No automatic deletion occurs.

Lease lifetime is 60 seconds. Renew every 15 seconds while admitting synchronized work. Server time decides expiry. Release and takeover advance epochs. Stale owners cannot commit. Replay requires the same idempotency key and manifest hash.

The client switch defaults off. Turning it off retains existing local journals. Restore recovers committed files and history, not running tools, pending external effects or process memory. Never import an offline divergent journal into an existing cloud ID. Create an explicit fork.

Credit coverage comes from the existing cost guard: https://github.com/Bavariance/polysimulator/issues/6877 and https://github.com/Bavariance/polysimulator/issues/6891#issuecomment-6125590217. Remaining credit: $4,992.74, valid through 2027-04-16. Workers, DO, KV, D1, Queues and R2 are covered. The existing Workers base fee is not a new cost. Do not change subscriptions or enable Containers.
