/**
 * Azure OpenAI deployment names, as configured by `AZURE_OPENAI_DEPLOYMENT_NAME_MAP`.
 *
 * A zero-import leaf: the remote summarizer resolves its wire model through it on
 * the launch graph, and importing it from `openai-shared.ts` pulled the OpenAI
 * request builders onto every launch. Callers pass the environment in, so the
 * leaf reads the variable without importing the module that loads `.env` files.
 */

/** The environment variable this module reads, and nothing else. */
export interface AzureDeploymentEnv {
	readonly AZURE_OPENAI_DEPLOYMENT_NAME_MAP?: string;
}

/**
 * Parse `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` (`model=deployment,model=deployment`)
 * into a model id to deployment name map. Entries without both halves are skipped.
 */
export function parseAzureDeploymentNameMap(value: string | undefined): Map<string, string> {
	const map = new Map<string, string>();
	if (!value) return map;
	for (const entry of value.split(",")) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		const [modelId, deploymentName] = trimmed.split("=", 2);
		if (!modelId || !deploymentName) continue;
		map.set(modelId.trim(), deploymentName.trim());
	}
	return map;
}

/** The deployment `modelId` maps to in `env`, or `modelId` itself when the map has no entry for it. */
export function azureDeploymentName(modelId: string, env: AzureDeploymentEnv): string {
	return parseAzureDeploymentNameMap(env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP).get(modelId) ?? modelId;
}

/**
 * The model id a request body sends: `requestModelId` when set, else `id`,
 * replaced by its deployment name when the model is served by Azure Responses.
 */
export function azureAwareWireModelId(
	model: { readonly api: string; readonly id: string; readonly requestModelId?: string },
	env: AzureDeploymentEnv,
): string {
	const requestModel = model.requestModelId ?? model.id;
	return model.api === "azure-openai-responses" ? azureDeploymentName(requestModel, env) : requestModel;
}
