import { ScramjetClient } from "@client/index";
import { String } from "@/shared/snapshot";

export default function (client: ScramjetClient, _self: Self) {
	client.Trap("PerformanceEntry.prototype.name", {
		get(ctx) {
			// name is going to be a url typically
			const name = String(ctx.get());

			if (name && name.startsWith(client.context.prefix.href)) {
				return client.unrewriteUrl(name);
			}

			return name;
		},
	});

	const filterEntries = (entries: PerformanceEntry[]) => {
		return entries.filter((entry) => {
			for (const file of client.config.maskedfiles) {
				const name = String(
					client.descriptors.get("PerformanceEntry.prototype.name", entry)
				);
				if (name.endsWith(file)) {
					return false;
				}
			}

			return true;
		});
	};

	client.Proxy(
		[
			"Performance.prototype.getEntries",
			"Performance.prototype.getEntriesByType",
			"Performance.prototype.getEntriesByName",
			"PerformanceObserverEntryList.prototype.getEntries",
			"PerformanceObserverEntryList.prototype.getEntriesByType",
			"PerformanceObserverEntryList.prototype.getEntriesByName",
		],
		{
			apply(ctx) {
				// entry names are stored as proxy urls, so an absolute url argument is looked up in that form
				if (
					typeof ctx.args[0] === "string" &&
					/^https?:\/\//i.test(ctx.args[0])
				) {
					ctx.args[0] = client.rewriteUrl(ctx.args[0]);
				}

				const entries = ctx.call() as PerformanceEntry[];

				return ctx.return(filterEntries(entries));
			},
		}
	);
}
