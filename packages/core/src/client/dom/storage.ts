import { ScramjetClient } from "@client/index";
import { Object_keys, Reflect_get, Reflect_ownKeys } from "@/shared/snapshot";

export default function (client: ScramjetClient, self: Self) {
	// stored keys are "<host>@<key>"; a page only ever sees its own namespace
	const prefix = () => client.url.host + "@";
	const ownStoredKeys = (target: Storage) =>
		Object_keys(target).filter((key) => key.startsWith(prefix()));

	const handler: ProxyHandler<Storage> = {
		get(target, prop) {
			switch (prop) {
				case "getItem":
					return (key: string) => {
						return target.getItem(client.url.host + "@" + key);
					};

				case "setItem":
					return (key: string, value: string) => {
						return target.setItem(client.url.host + "@" + key, value);
					};

				case "removeItem":
					return (key: string) => {
						return target.removeItem(client.url.host + "@" + key);
					};

				case "clear":
					return () => {
						for (const key of ownStoredKeys(target)) {
							target.removeItem(key);
						}
					};

				case "key":
					return (index: number) => {
						const key = ownStoredKeys(target)[index];

						if (key === undefined) return null;
						return key.substring(prefix().length);
					};

				case "length":
					return ownStoredKeys(target).length;

				default:
					if (prop in Object.prototype || typeof prop === "symbol") {
						return Reflect_get(target, prop);
					}

					// a missing named property is undefined, not null (only getItem returns null)
					return (
						target.getItem(client.url.host + "@" + (prop as string)) ??
						undefined
					);
			}
		},

		set(target, prop, value) {
			target.setItem(client.url.host + "@" + (prop as string), value);

			return true;
		},

		has(target, prop) {
			return target.getItem(client.url.host + "@" + (prop as string)) !== null;
		},

		deleteProperty(target, prop) {
			target.removeItem(client.url.host + "@" + (prop as string));

			return true;
		},

		ownKeys(target) {
			return Reflect_ownKeys(target)
				.filter((f) => typeof f === "string" && f.startsWith(prefix()))
				.map((f) => (typeof f === "string" ? f.substring(prefix().length) : f));
		},

		getOwnPropertyDescriptor(target, property) {
			// TODO: probably not right
			if (
				target.getItem(client.url.host + "@" + (property as string)) === null
			) {
				return undefined;
			}

			return {
				value: target.getItem(client.url.host + "@" + (property as string)),
				enumerable: true,
				configurable: true,
				writable: true,
			};
		},

		defineProperty(target, property, attributes) {
			target.setItem(
				client.url.host + "@" + (property as string),
				attributes.value
			);

			return true;
		},
	};

	const realLocalStorage = self.localStorage;
	const realSessionStorage = self.sessionStorage;
	const localStorageProxy = new Proxy(realLocalStorage, handler);
	const sessionStorageProxy = new Proxy(realSessionStorage, handler);

	delete self.localStorage;
	delete self.sessionStorage;

	self.localStorage = localStorageProxy;
	self.sessionStorage = sessionStorageProxy;

	// Web IDL needs a real Storage for StorageEvent.storageArea, so unwrap the
	// proxies when constructing an event and re-wrap them when reading it back.
	const toReal = (area: unknown) =>
		area === localStorageProxy
			? realLocalStorage
			: area === sessionStorageProxy
				? realSessionStorage
				: area;
	const toProxy = (area: unknown) =>
		area === realLocalStorage
			? localStorageProxy
			: area === realSessionStorage
				? sessionStorageProxy
				: area;

	client.Proxy("StorageEvent", {
		construct(ctx) {
			const init = ctx.args[1];
			if (init && typeof init === "object" && "storageArea" in init) {
				ctx.args[1] = { ...init, storageArea: toReal(init.storageArea) };
			}
		},
	});
	client.Trap("StorageEvent.prototype.storageArea", {
		get(ctx) {
			return toProxy(ctx.get());
		},
	});
}
