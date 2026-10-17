// Response bodies cross from the controller (page or worker) to the service worker over a
// MessagePort instead of as a transferred ReadableStream. A transferred stream is pull-based:
// every chunk waits for a request from the other thread, so a body that arrives in many chunks
// pays one cross-thread round trip per chunk (a 400 KB document took ~300 ms longer to finish
// than when buffered). Here the sender pushes chunks as they come, and the receiver acks the
// bytes its consumer has taken, which bounds how far ahead the sender gets.

// bytes sent but not yet consumed on the other side, before the sender waits
const WINDOW = 4 * 1024 * 1024;

type BodyMessage =
	| { chunk: Uint8Array }
	| { done: true }
	| { error: string }
	| { ack: number }
	| { cancel: true };

/** Pumps `stream` into a new port and returns the other end, to transfer to the receiver. */
export function sendBody(stream: ReadableStream<Uint8Array>): MessagePort {
	const { port1, port2 } = new MessageChannel();
	void sendBodyTo(stream, port1);
	return port2;
}

/**
 * Pumps `stream` into `port1`, whose other end goes to receiveBody. Resolves once the body has
 * been sent, cancelled by the receiver, or failed.
 */
export function sendBodyTo(
	stream: ReadableStream<Uint8Array>,
	port1: MessagePort
): Promise<void> {
	const reader = stream.getReader();
	let inflight = 0;
	let resume: (() => void) | null = null;
	let cancelled = false;

	port1.onmessage = (e: MessageEvent<BodyMessage>) => {
		const msg = e.data;
		if ("ack" in msg) {
			inflight -= msg.ack;
			if (inflight < WINDOW && resume) {
				resume();
				resume = null;
			}
		} else if ("cancel" in msg) {
			cancelled = true;
			reader.cancel().catch(() => {});
			resume?.();
			port1.close();
		}
	};

	return (async () => {
		try {
			for (;;) {
				if (inflight >= WINDOW) await new Promise<void>((r) => (resume = r));
				if (cancelled) return;
				const { done, value } = await reader.read();
				if (cancelled) return;
				if (done) break;
				if (!value?.byteLength) continue;
				// transfer the bytes when they own their whole buffer, otherwise send a copy
				const chunk =
					value.byteOffset === 0 &&
					value.byteLength === value.buffer.byteLength &&
					value.buffer instanceof ArrayBuffer
						? value
						: value.slice();
				inflight += chunk.byteLength;
				port1.postMessage({ chunk } satisfies BodyMessage, [chunk.buffer]);
			}
			port1.postMessage({ done: true } satisfies BodyMessage);
		} catch (err) {
			if (!cancelled)
				port1.postMessage({ error: String(err) } satisfies BodyMessage);
		}
	})();
}

/** The body arriving on `port` (from sendBody), as a stream. */
export function receiveBody(port: MessagePort): ReadableStream<Uint8Array> {
	let unacked = 0;
	let finished = false;
	const ack = () => {
		if (unacked > 0 && !finished) {
			port.postMessage({ ack: unacked } satisfies BodyMessage);
			unacked = 0;
		}
	};

	return new ReadableStream<Uint8Array>(
		{
			start(controller) {
				port.onmessage = (e: MessageEvent<BodyMessage>) => {
					const msg = e.data;
					if ("chunk" in msg) {
						controller.enqueue(msg.chunk);
						unacked += msg.chunk.byteLength;
						// the consumer is keeping up: let the sender go on
						if ((controller.desiredSize ?? 0) > 0) ack();
					} else if ("done" in msg) {
						finished = true;
						controller.close();
						port.close();
					} else if ("error" in msg) {
						finished = true;
						controller.error(new Error(msg.error));
						port.close();
					}
				};
			},
			// the consumer took chunks out of the queue: ack what has arrived so far
			pull() {
				ack();
			},
			cancel() {
				finished = true;
				port.postMessage({ cancel: true } satisfies BodyMessage);
				port.close();
			},
		},
		{ highWaterMark: WINDOW, size: (chunk) => chunk.byteLength }
	);
}

// the ports of receiveForwardable's streams that nobody has read yet
const unread = new WeakMap<ReadableStream<Uint8Array>, MessagePort>();

/**
 * receiveBody, for a body that may only be passing through this thread: until the stream is
 * read, takePort hands out the port itself, to send on to the body's real receiver.
 */
export function receiveForwardable(
	port: MessagePort
): ReadableStream<Uint8Array> {
	let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
	const stream = new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				if (!reader) {
					unread.delete(stream);
					reader = receiveBody(port).getReader();
				}
				const { done, value } = await reader.read();
				if (done) controller.close();
				else controller.enqueue(value);
			},
			cancel(reason) {
				unread.delete(stream);
				if (reader) return reader.cancel(reason);
				port.postMessage({ cancel: true } satisfies BodyMessage);
				port.close();
			},
		},
		// nothing is read from the port before someone reads the stream
		{ highWaterMark: 0 }
	);
	unread.set(stream, port);
	return stream;
}

/** the port behind a receiveForwardable stream that hasn't been read; the stream is then spent */
export function takePort(
	stream: ReadableStream<Uint8Array>
): MessagePort | undefined {
	if (stream.locked) return undefined;
	const port = unread.get(stream);
	unread.delete(stream);
	return port;
}

/** `body` as a stream whose bytes go as they come, but which ends only once `settled` has */
export function endAfter(
	body: string | ArrayBuffer | Blob | ReadableStream<Uint8Array>,
	settled: Promise<unknown>
): ReadableStream<Uint8Array> {
	const stream =
		body instanceof ReadableStream ? body : new Response(body).body!;
	return stream.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			flush: () =>
				settled.then(
					() => {},
					() => {}
				),
		})
	);
}
