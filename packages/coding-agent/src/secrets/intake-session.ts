import type { SecretIntakeBroker, SecretIntakeContext } from "./intake-broker";

interface SessionSecretIntakeBinding {
	broker: SecretIntakeBroker;
	context: Readonly<SecretIntakeContext>;
}
const bindings = new WeakMap<object, SessionSecretIntakeBinding>();
interface SessionSecretIntakeFactory {
	ownerSessionId: string;
	create(actorId: string): Promise<SessionSecretIntakeBinding>;
	isCurrent?: () => boolean;
	pending?: Promise<SessionSecretIntakeBinding>;
	actorId?: string;
}
const factories = new WeakMap<object, SessionSecretIntakeFactory>();
const aliases = new WeakMap<object, object>();

/** The SDK links the native session to its own tool session, never to a derived child's state. */
export function installSessionSecretIntakeAlias(alias: object, source: object): () => void {
	if (alias === source || aliases.has(alias) || aliases.has(source)) throw new Error("Invalid secret intake alias");
	aliases.set(alias, source);
	return () => { if (aliases.get(alias) === source) aliases.delete(alias); };
}

export function hasSessionSecretIntakeFactory(session: object): boolean {
	const factory = factories.get(aliases.get(session) ?? session);
	return factory !== undefined && factory.isCurrent?.() !== false;
}

/** The SDK installs mechanics; only a trusted native host may attest the operator principal. */
export function installSessionSecretIntakeFactory(
	session: object,
	ownerSessionId: string,
	create: (actorId: string) => Promise<SessionSecretIntakeBinding>,
	isCurrent?: () => boolean,
): () => void {
	if (factories.has(session) || bindings.has(session)) throw new Error("Secret intake is already installed");
	const factory: SessionSecretIntakeFactory = { ownerSessionId, create, isCurrent };
	factories.set(session, factory);
	return () => {
		if (factories.get(session) !== factory) return;
		factories.delete(session);
		const bound = bindings.get(session);
		bindings.delete(session);
		bound?.broker.close();
	};
}

/** Called only after the native owner-token transport authenticates the daemon's configured actor. */
export async function registerSessionSecretIntakeActor(
	session: object,
	actorId: string,
	ownerSessionId: string,
): Promise<Readonly<SecretIntakeContext>> {
	if (!/^[0-9]{1,32}$/.test(actorId)) throw new Error("Secret intake actor refused");
	session = aliases.get(session) ?? session;
	const factory = factories.get(session);
	if (!factory || factory.isCurrent?.() === false || factory.ownerSessionId !== ownerSessionId || (factory.actorId && factory.actorId !== actorId)) {
		throw new Error("Secret intake actor refused");
	}
	factory.actorId = actorId;
	factory.pending ??= factory.create(actorId);
	const binding = await factory.pending;
	if (factories.get(session) !== factory || factory.isCurrent?.() === false || binding.context.actorId !== actorId || binding.context.ownerSessionId !== ownerSessionId) {
		binding.broker.close();
		throw new Error("Secret intake actor refused");
	}
	bindings.set(session, binding);
	return binding.context;
}

/** Native SDK construction installs this authority. Derived sessions never inherit it. */
export function installSessionSecretIntake(session: object, broker: SecretIntakeBroker, context: SecretIntakeContext): () => void {
	if (bindings.has(session)) throw new Error("Secret intake is already installed");
	const binding = { broker, context: Object.freeze({ ...context }) };
	bindings.set(session, binding);
	return () => {
		if (bindings.get(session) !== binding) return;
		bindings.delete(session);
		broker.close();
	};
}

/** Optional host capability: its absence must never trigger a plaintext fallback. */
export function getSessionSecretIntake(session: object): SecretIntakeBroker | undefined {
	const owner = aliases.get(session) ?? session;
	if (factories.get(owner)?.isCurrent?.() === false) return undefined;
	return bindings.get(owner)?.broker;
}

/** Context comes only from native construction, not model tool or RPC JSON fields. */
export function getSessionSecretIntakeContext(session: object): Readonly<SecretIntakeContext> | undefined {
	const owner = aliases.get(session) ?? session;
	if (factories.get(owner)?.isCurrent?.() === false) return undefined;
	return bindings.get(owner)?.context;
}
