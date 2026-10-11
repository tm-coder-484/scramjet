import { ScramjetClient } from "@client/index";
import {
	Object_defineProperty,
	Object_getOwnPropertyDescriptor,
	Object_keys,
	Object_values,
	Reflect_apply,
	Reflect_get,
	Reflect_ownKeys,
} from "@/shared/snapshot";

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

	// the storage areas are opened on first access, as natively: reading self.localStorage makes
	// Blink load the origin's storage synchronously (~3ms per document), and throws where storage
	// is unavailable, so doing it during hook setup cost every page that never uses storage
	const areas: Record<
		"localStorage" | "sessionStorage",
		{ real?: Storage; proxy?: Storage }
	> = { localStorage: {}, sessionStorage: {} };
	for (const name of ["localStorage", "sessionStorage"] as const) {
		const native = Object_getOwnPropertyDescriptor(self, name);
		if (!native?.get) continue;
		const nativeGet = native.get;
		const area = areas[name];
		const { get } = {
			get() {
				if (!area.proxy) {
					area.real = Reflect_apply(nativeGet, self, []);
					area.proxy = new Proxy(area.real!, handler);
				}

				return area.proxy;
			},
		};
		// looks like the native getter: its name, and its source text through toString
		Object_defineProperty(get, "name", { value: nativeGet.name });
		client.box.unproxy.set(get, nativeGet);
		Object_defineProperty(self, name, {
			get,
			set: native.set,
			enumerable: native.enumerable,
			configurable: native.configurable,
		});
	}

	// Web IDL needs a real Storage for StorageEvent.storageArea, so unwrap the
	// proxies when constructing an event and re-wrap them when reading it back.
	const toReal = (area: unknown) => {
		for (const a of Object_values(areas)) if (area && area === a.proxy) return a.real;

		return area;
	};
	const toProxy = (area: unknown) => {
		for (const a of Object_values(areas)) if (area && area === a.real) return a.proxy;

		return area;
	};

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
