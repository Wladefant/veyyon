import type { AuthGatewayStreamControl, FrameSink } from "./types";

const FRAME_ENCODER = new TextEncoder();

/** The response body an encoder writes its frames to. */
export interface GatewayStreamOut extends FrameSink {
	/** Aborts when the gateway request signal aborts or the client cancels the body. */
	readonly signal: AbortSignal;
	enqueue(frame: string | Uint8Array): void;
	/** Ends the body after the format's last frame. */
	close(): void;
}

/** One streaming response in a wire format. */
export interface GatewayStreamEncoder {
	/** Writes every frame of the response and closes `out` when the format's stream is complete. */
	run(): Promise<void>;
	/** Writes the format's error frames for an exception `run` threw while the client was connected. */
	fail(err: unknown): void;
}

/**
 * The response body of a streaming gateway request.
 *
 * `open` builds the encoder once the body starts. A request signal that aborted before then closes
 * the body with no frames. An exception from `run` reaches `fail` only while the client is
 * connected, and the body closes after it. A client cancel aborts `out.signal` and calls
 * `control.onCancel` with the cancel reason.
 */
export function gatewayResponseStream(
	control: AuthGatewayStreamControl | undefined,
	open: (out: GatewayStreamOut) => GatewayStreamEncoder,
): ReadableStream<Uint8Array> {
	const stop = new AbortController();
	const request = control?.signal;
	const onRequestAbort = () => stop.abort(request?.reason);
	if (request?.aborted) stop.abort(request.reason);
	else request?.addEventListener("abort", onRequestAbort, { once: true });

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const out: GatewayStreamOut = {
				signal: stop.signal,
				get cancelled() {
					return stop.signal.aborted;
				},
				enqueue: frame => controller.enqueue(typeof frame === "string" ? FRAME_ENCODER.encode(frame) : frame),
				close: () => controller.close(),
			};
			let encoder: GatewayStreamEncoder | undefined;
			try {
				if (out.cancelled) {
					controller.close();
					return;
				}
				encoder = open(out);
				await encoder.run();
			} catch (err) {
				// An encoder that could not be built has no error frame to write: the body errors instead.
				if (!encoder) throw err;
				if (!out.cancelled) {
					encoder.fail(err);
					controller.close();
				}
			} finally {
				request?.removeEventListener("abort", onRequestAbort);
			}
		},
		cancel(reason) {
			stop.abort(reason);
			request?.removeEventListener("abort", onRequestAbort);
			control?.onCancel?.(reason);
		},
	});
}
