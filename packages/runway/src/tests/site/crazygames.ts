import type { Locator, Page } from "playwright";
import { playwrightTest } from "../../testcommon.ts";

// A game on CrazyGames, played. The game page embeds the CrazyGames gameframe (games.crazygames.com,
// whose module bundle comes from builds.crazygames.com), which embeds the game itself from
// <game>.game-files.crazygames.com: three origins, an iframe with id game-iframe at each level.
// Moto X3M draws to a canvas. The test clicks PLAY on its title screen, picks level 1 and drives
// with the right arrow, checking after each step that the canvas shows something new.

const GAME = "https://www.crazygames.com/game/moto-x3m";

// an empty or one-color canvas compresses to a few KB; any of the game's screens is far bigger
const DRAWN_PNG_BYTES = 50_000;

async function waitForScreen(
	page: Page,
	canvas: Locator,
	previous: Buffer | null,
	what: string,
	timeoutMs = 15_000
): Promise<Buffer> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		// eslint-disable-next-line no-await-in-loop
		const shot = await canvas.screenshot();
		if (
			shot.length > DRAWN_PNG_BYTES &&
			(!previous || !shot.equals(previous))
		)
			return shot;
		if (Date.now() > deadline) throw new Error(`the game never showed ${what}`);
		// eslint-disable-next-line no-await-in-loop
		await page.waitForTimeout(500);
	}
}

export default [
	playwrightTest({
		name: "site-crazygames-game",
		fn: async ({ page, frame, navigate }) => {
			await navigate(GAME);

			const canvas = frame
				.frameLocator("#game-iframe")
				.frameLocator("#game-iframe")
				.locator("canvas")
				.first();
			await canvas.waitFor({ state: "visible", timeout: 60_000 });

			await waitForScreen(page, canvas, null, "its title screen", 60_000);
			// the title screen's buttons come in with an animation
			await page.waitForTimeout(4000);
			const title = await canvas.screenshot();

			const box = (await canvas.boundingBox())!;
			const click = (x: number, y: number) =>
				page.mouse.click(box.x + box.width * x, box.y + box.height * y);

			// PLAY, on the right of the title screen
			await click(0.84, 0.41);
			const map = await waitForScreen(page, canvas, title, "the level map");
			await page.waitForTimeout(1500);

			// level 1: the first stop on the map, bottom left
			await click(0.166, 0.776);
			await waitForScreen(page, canvas, map, "level 1");
			await page.waitForTimeout(2000);

			// drive: the game takes keys in its own frame, which the click focused
			await page.keyboard.down("ArrowRight");
			await page.waitForTimeout(600);
			const a = await canvas.screenshot();
			await page.waitForTimeout(600);
			const b = await canvas.screenshot();
			await page.keyboard.up("ArrowRight");
			if (a.equals(b)) throw new Error("the game stopped drawing while played");
		},
	}),
];
