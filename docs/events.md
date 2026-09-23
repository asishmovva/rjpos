# Events

Outbox rows are claimed from PostgreSQL using `FOR UPDATE SKIP LOCKED`. Processing is at least once. Failures return to pending with backoff until the attempt limit, then become visible failed rows. Claims older than the stale threshold are recovered. Event handlers must be idempotent; exactly-once delivery is not claimed.
