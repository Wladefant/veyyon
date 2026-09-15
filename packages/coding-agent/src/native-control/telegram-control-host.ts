import type { AgentRegistry } from "../registry/agent-registry";
import {
	type AgentDetailRequest,
	type AgentListRequest,
	type NativeAgentDetail,
	type NativeAgentSummary,
	type NativeControlAuth,
	type NativeControlBinding,
	NativeControlDeniedError,
	TelegramNativeControlBridge,
} from "./telegram-control-bridge";

export const TELEGRAM_NATIVE_CONTROL_HOST_SYMBOL = Symbol.for("veyyon.telegram.native-control-host.v1");

export interface TelegramNativeControlClient {
	getSessionIdentity(auth: NativeControlAuth): { id: string; actorId: string; chatId: string };
	listAgents(request: AgentListRequest): Promise<{ items: NativeAgentSummary[]; nextCursor?: string }>;
	getAgentDetail(request: AgentDetailRequest): Promise<NativeAgentDetail>;
}

export interface TelegramNativeControlHost {
	readonly version: 1;
	bind(binding: NativeControlBinding): TelegramNativeControlClient;
}

export interface InstallTelegramNativeControlHostOptions {
	registry?: AgentRegistry;
}

interface TelegramNativeControlGlobal {
	[TELEGRAM_NATIVE_CONTROL_HOST_SYMBOL]?: TelegramNativeControlHost;
}

class ActiveSessionClient implements TelegramNativeControlClient {
	constructor(
		private readonly bridge: TelegramNativeControlBridge,
		private readonly boundSessionId: string,
		private readonly currentSessionId: () => string,
	) {}

	getSessionIdentity(auth: NativeControlAuth): { id: string; actorId: string; chatId: string } {
		this.assertActive();
		return this.bridge.getSessionIdentity(auth);
	}

	async listAgents(request: AgentListRequest): Promise<{ items: NativeAgentSummary[]; nextCursor?: string }> {
		this.assertActive();
		return await this.bridge.listAgents(request);
	}

	async getAgentDetail(request: AgentDetailRequest): Promise<NativeAgentDetail> {
		this.assertActive();
		return await this.bridge.getAgentDetail(request);
	}

	private assertActive(): void {
		if (this.currentSessionId() !== this.boundSessionId) {
			throw new NativeControlDeniedError("SESSION_NOT_ACTIVE", "The bound native session is no longer active");
		}
	}
}

/**
 * Publishes the native control capability inside this Veyyon process. The host
 * owns no external transport or credential store; an authorized extension
 * supplies its authenticated binding. A session switch invalidates every
 * previously bound client.
 */
export function installTelegramNativeControlHost(
	currentSessionId: () => string,
	options: InstallTelegramNativeControlHostOptions = {},
): TelegramNativeControlHost {
	const host: TelegramNativeControlHost = {
		version: 1,
		bind(binding) {
			if (binding.sessionId !== currentSessionId()) {
				throw new NativeControlDeniedError("SESSION_NOT_ACTIVE", "Cannot bind Telegram control to an inactive session");
			}
			const bridge = new TelegramNativeControlBridge({
				binding,
				...(options.registry ? { registry: options.registry } : {}),
			});
			return new ActiveSessionClient(bridge, binding.sessionId, currentSessionId);
		},
	};
	const globalState = globalThis as TelegramNativeControlGlobal;
	globalState[TELEGRAM_NATIVE_CONTROL_HOST_SYMBOL] = host;
	return host;
}

export function getTelegramNativeControlHost(): TelegramNativeControlHost | undefined {
	return (globalThis as TelegramNativeControlGlobal)[TELEGRAM_NATIVE_CONTROL_HOST_SYMBOL];
}
