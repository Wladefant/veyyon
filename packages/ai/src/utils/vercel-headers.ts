import { APP_DISPLAY_NAME } from "@veyyon/utils/app-identity";
import { SITE_URL } from "@veyyon/utils/dirs";

/** Public homepage URL that inference gateways credit traffic to. */
export const VERCEL_AI_GATEWAY_REFERER: string = `${SITE_URL}/`;

/** Application title credited on Vercel AI Gateway routes. */
export const VERCEL_AI_GATEWAY_TITLE: string = APP_DISPLAY_NAME;

/**
 * Standard app attribution headers for Vercel AI Gateway requests.
 *
 * Sent as `http-referer` and `x-title`; caller-supplied headers take
 * precedence.
 */
export function getVercelAiGatewayHeaders(): Record<string, string> {
	return {
		"http-referer": VERCEL_AI_GATEWAY_REFERER,
		"x-title": VERCEL_AI_GATEWAY_TITLE,
	};
}
