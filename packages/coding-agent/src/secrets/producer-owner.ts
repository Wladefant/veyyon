import { AsyncLocalStorage } from "node:async_hooks";

export interface ProducerSecretOwner {
	redact(text: string): string;
	pendingPrefixLength?(text: string): number;
}

const activeOwner = new AsyncLocalStorage<ProducerSecretOwner>();
const ownerByArguments = new WeakMap<object, ProducerSecretOwner>();

/** Run an operation with the redaction authority owned by its producing job. */
export function runWithProducerSecretOwner<T>(owner: ProducerSecretOwner, operation: () => T): T {
	return activeOwner.run(owner, operation);
}

/** Redact under the active job owner, or leave text unchanged outside a job. */
export function producerRedactText(text: string): string {
	return activeOwner.getStore()?.redact(text) ?? text;
}

/** Return the redaction owner active in this async execution context. */
export function currentProducerSecretOwner(): ProducerSecretOwner | undefined {
	return activeOwner.getStore();
}

/** Associate a final execution-arguments object with its admitted job owner. */
export function bindProducerSecretOwner<T extends object>(args: T, owner: ProducerSecretOwner): T {
	ownerByArguments.set(args, owner);
	return args;
}

/** Return the owner associated with an execution-arguments object, if any. */
export function producerSecretOwnerFor(args: object): ProducerSecretOwner | undefined {
	return ownerByArguments.get(args);
}
