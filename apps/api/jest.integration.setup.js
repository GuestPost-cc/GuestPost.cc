// Integration tests clone databases, acquire PostgreSQL locks, and exercise
// real transactional contention. Jest does not honor `testTimeout` inside an
// individual project config, so set the integration-only timeout at runtime.
jest.setTimeout(30_000)
