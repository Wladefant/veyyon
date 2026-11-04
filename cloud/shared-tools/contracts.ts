export type ToolScope = "fetch:public" | "search:public";
export interface AdmissionIdentity { userId: string; deviceId: string }
export type BudgetRefusal = "minute_limit" | "month_limit" | "cost_limit" | "expired";
export type Reservation = { allowed: true } | { allowed: false; reason: BudgetRefusal };
export interface ToolBudget { reserve(userId: string, nowMs: number, costMicrousd: number): Promise<Reservation> }
export interface UserPolicy { userId: string; enabled: boolean; scopes: ToolScope[] }
export interface DevicePolicy { deviceId: string; userId: string; clientId: string; secretSha256: string; enabled: boolean; expiresAt: number }
export interface SecretBinding { userId: string; value: string; sha256: string; costMicrousdPerRequest: number }
export interface AdmissionPolicy { enabled: boolean; users: UserPolicy[]; devices: DevicePolicy[]; tools: Record<ToolScope, boolean> }
export interface BudgetLimits { minute: number; month: number; costMicrousd: number; totalMonth: number; totalCostMicrousd: number; expiresAt: number }
export interface SqlCursor<T> { toArray(): T[] }
export interface SqlStorage { exec<T extends Record<string, unknown> = Record<string, unknown>>(query: string, ...bindings: (string | number | null)[]): SqlCursor<T> }
export interface DurableStorage {
	sql: SqlStorage;
	transactionSync<T>(callback: () => T): T;
	setAlarm?(date: number): Promise<void>;
	getAlarm?(): Promise<number | null>;
}
export interface BudgetState { storage: DurableStorage }
export interface BudgetAuthorityBinding { fetch(request: Request): Promise<Response> }
export interface BudgetNamespace { idFromName(name: string): unknown; get(id: unknown): BudgetAuthorityBinding }
