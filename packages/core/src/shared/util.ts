import {
	_Uint8Array,
	atob,
	btoa,
	Reflect_apply,
	TextEncoder_encode,
	String_fromCharCode,
} from "@/shared/snapshot";

// String.fromCharCode takes its bytes as arguments, so feed it in chunks to keep the call stack small
const BASE64_CHUNK = 0x8000;

function bytesToBase64Fallback(bytes: Uint8Array): string {
	let binString = "";
	for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
		binString += Reflect_apply(
			String_fromCharCode,
			null,
			bytes.subarray(i, i + BASE64_CHUNK)
		);
	}

	return btoa(binString);
}

const bytesToBase64Native: ((this: Uint8Array) => string) | undefined = (
	Uint8Array.prototype as any
).toBase64;

export const bytesToBase64: (bytes: Uint8Array) => string =
	typeof bytesToBase64Native === "function"
		? (bytes) => bytesToBase64Native.call(bytes)
		: bytesToBase64Fallback;

// the wrapped constructor's type keeps only its zero-argument overload, so spell out the one used here
export const Uint8ArrayCtor = _Uint8Array as unknown as new (
	source: number | ArrayLike<number>
) => Uint8Array;

function base64ToBytesFallback(text: string): Uint8Array {
	const binString = atob(text);
	const bytes = new Uint8ArrayCtor(binString.length);
	for (let i = 0; i < binString.length; i++) bytes[i] = binString.charCodeAt(i);

	return bytes;
}

const base64ToBytesNative: ((text: string) => Uint8Array) | undefined = (
	_Uint8Array as any
).fromBase64;

export const base64ToBytes: (text: string) => Uint8Array =
	typeof base64ToBytesNative === "function"
		? (text) => base64ToBytesNative(text)
		: base64ToBytesFallback;

export function base64Encode(text: string) {
	return bytesToBase64(TextEncoder_encode(text));
}
