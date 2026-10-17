import { ScramjetClient } from "@client/index";

export default function (client: ScramjetClient, self: Self) {
	client.Trap("Document.prototype.cookie", {
		get() {
			// getCookies only reads the url's hostname and pathname, so the cached view is enough
			return client.context.cookieJar.getCookies(client.peekUrl(), true);
		},
		set(ctx, value: string) {
			client.context.cookieJar.setCookies(value, client.url);
			client.init.sendSetCookie([
				{
					url: client.url,
					cookie: value,
				},
			]);
		},
	});

	// @ts-ignore
	delete self.cookieStore;
}
