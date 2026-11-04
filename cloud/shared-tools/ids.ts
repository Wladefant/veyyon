/**
 * One rule for every identifier that crosses the admission and budget boundary. A user, a device
 * and a client request ID are opaque ASCII tokens. Admission, the Worker and the budget authority
 * all apply this check, so an identity admission accepts can never be one the budget rejects, and a
 * value that is not in this form is refused before it reaches a key, a counter or an audit row.
 */
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isOpaqueId(value: unknown): value is string {
	return typeof value === "string" && OPAQUE_ID.test(value);
}
