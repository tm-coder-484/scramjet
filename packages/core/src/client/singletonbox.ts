import { IncrementalHtmlRewriter } from "@/shared";
import { ScramjetClient } from "./client";
import { SourceMaps } from "./shared/sourcemaps";
import { Object_getOwnPropertyDescriptor } from "@/shared/snapshot";

// the constructor names scramjet passes to SingletonBox.instanceof
const INSTANCEOF_NAMES = [
	"Document",
	"Error",
	"HTMLScriptElement",
	"HTMLStyleElement",
	"MathMLElement",
	"Object",
	"Request",
	"SVGElement",
	"SVGForeignObjectElement",
	"SVGScriptElement",
	"Text",
	"TrustedScript",
];

export class SingletonBox {
	clients: ScramjetClient[] = [];
	globals: Map<Self, ScramjetClient> = new Map();
	documents: Map<Document, ScramjetClient> = new Map();
	histories: Map<History, ScramjetClient> = new Map();
	locations: Map<Location, ScramjetClient> = new Map();
	writeRewriters = new WeakMap<Document, IncrementalHtmlRewriter>();
	unproxy = new Map<any, any>();

	ctors: Record<string, Function[]> = {};

	sourcemaps: SourceMaps = {};

	constructor(public ownerclient: ScramjetClient) {}

	registerClient(client: ScramjetClient, global: Self) {
		this.clients.push(client);
		this.globals.set(global, client);
		this.documents.set(global.document, client);
		this.locations.set(global.location, client);
		this.histories.set(global.history, client);

		this.registeredGlobals.push(global);
		// only the constructors instanceof() is asked about. reading every global's descriptor made
		// Blink create all of its ~800 lazily-built interface objects, ~10ms per document. they're
		// taken now, before page code can replace them
		for (const name of INSTANCEOF_NAMES) this.addCtor(global, name);
	}

	private registeredGlobals: Self[] = [];

	private addCtor(global: Self, name: string) {
		const desc = Object_getOwnPropertyDescriptor(global, name);
		if (desc && typeof desc.value === "function") {
			if (!this.ctors[name]) this.ctors[name] = [];
			this.ctors[name].push(desc.value);
		}
	}

	instanceof(obj: any, name: string): boolean {
		let ctors = this.ctors[name];
		if (!ctors) {
			// a name outside INSTANCEOF_NAMES: look it up now
			for (const global of this.registeredGlobals) this.addCtor(global, name);
			ctors = this.ctors[name];
		}
		if (!ctors) {
			dbg.error(`No constructors for ${name} found`);
			return false;
		}
		for (const ctor of ctors) {
			// eslint-disable-next-line scramjet-core/no-instanceof
			if (obj instanceof ctor) return true;
		}
		return false;
	}
}
