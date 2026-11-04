/** WHY: A running parent was treated as a competing writer. Registry lineage, not names,
 * establishes delegation. This checks identity only; it does not prove model compliance or file ownership. */
import { describe, expect, it } from "bun:test";
import { AgentRegistry } from "../src/registry/agent-registry";

describe("handoff actor identity", () => {
	it("uses actual parent IDs even when names and dotted prefixes disagree", () => {
		const registry = new AgentRegistry();
		registry.register({ id: "root", displayName: "Main", kind: "main", scope: "conversation", session: null });
		registry.register({ id: "owner", displayName: "Other", kind: "sub", parentId: "root", session: null });
		registry.register({ id: "worker", displayName: "Main.Fake", kind: "sub", parentId: "owner", session: null });
		registry.register({ id: "worker.Fake", displayName: "owner", kind: "sub", parentId: "root", session: null });
		expect(registry.actorContext("worker")).toEqual({ selfId: "worker", parentId: "owner", ancestorIds: ["owner", "root"], scope: "conversation" });
		expect(registry.relationTo("worker", "owner")).toBe("parent");
		expect(registry.relationTo("worker", "root")).toBe("ancestor");
		expect(registry.relationTo("worker", "worker.Fake")).toBe("peer");
		expect(registry.relationTo("worker", "missing")).toBe("unknown");
	});
	it("does not accept missing, cyclic or foreign-scope ancestry", () => {
		const registry = new AgentRegistry();
		registry.register({ id: "a", displayName: "a", kind: "sub", parentId: "b", scope: "one", session: null });
		expect(registry.actorContext("a").ancestorIds).toEqual([]);
		registry.register({ id: "b", displayName: "b", kind: "sub", parentId: "a", scope: "two", session: null });
		expect(registry.actorContext("a").ancestorIds).toEqual([]);
		registry.register({ id: "b", displayName: "b", kind: "sub", parentId: "a", scope: "one", session: null });
		expect(registry.actorContext("a").ancestorIds).toEqual(["b"]);
	});
});
