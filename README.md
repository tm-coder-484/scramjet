<h1 align="center">Scramjet</h1>
<div align="center">
  <img src="assets/scramjet.png" height="200" />
</div>

<div align="center">
  <a href="https://www.npmjs.com/package/@mercuryworkshop/scramjet"><img src="https://img.shields.io/npm/v/@mercuryworkshop/scramjet.svg?maxAge=3600" alt="npm version" /></a>
  <img src="https://img.shields.io/github/issues/MercuryWorkshop/scramjet?style=flat&color=orange" />
  <img src="https://img.shields.io/github/stars/MercuryWorkshop/scramjet?style=flat&color=orange" />
</div>

---

Scramjet is an experimental interception-based web proxy designed to evade internet censorship and bypass arbitrary browser restrictions.<br><br>
Scramjet allows you to sandbox arbitrary web content, bypass CORS restrictions on loading websites, and instrument and debug websites inside the browser itself. This is accomplished through a combination of interception, rewriting, and sandboxing techniques. You can learn more about the technical details <a href="https://developer.puter.com/blog/how-I-ported-the-web-to-the-web/"><strong>here</strong></a>.<br><br>

## Supported Sites

Some of the popular websites that Scramjet supports include:

- [Google](https://google.com)
- [Youtube](https://youtube.com)
- [Instagram](https://instagram.com)
- [ChatGPT](https://chatgpt.com)
- [Reddit](https://reddit.com)
- [Twitter](https://twitter.com)
- [Discord](https://discord.com)
- [Spotify](https://spotify.com)
- [GeForce NOW](https://play.geforcenow.com/)
- [now.gg](https://now.gg)

## Development

### Dependencies

- Recent versions of `node.js` and `pnpm`
- `rustup`
- `wasm-bindgen`
- [Binaryen's `wasm-opt`](https://github.com/WebAssembly/binaryen)
- [this `wasm-snip` fork](https://github.com/r58Playz/wasm-snip)

#### Building

- Clone the repository with `git clone --recursive https://github.com/MercuryWorkshop/scramjet`
- Install the dependencies with `pnpm i`
- Change directories with `cd packages/core`
- Build the rewriter with `pnpm rewriter:build`
- Build Scramjet with `pnpm build`

### Running Scramjet Locally

You can run the Scramjet dev server when running this command at the root

```sh
pnpm dev
```

The demo page for scramjet should now be running at <http://localhost:4141> and should rebuild upon a file being changed (excluding the rewriter).

#### Transports

The demo's settings page picks how requests leave the browser:

- **Relay** (the default): the dev server makes each request itself, with native TLS, HTTP/2 and a DNS cache, and streams responses back over one websocket. The controller then runs in a worker, so requests never wait on the proxied page's main thread. It also prefetches a page's stylesheets, scripts and first images while the HTML streams through, keeps a shared HTTP cache that follows the rules for shared caches (RFC 9111), keeps its connections to sites open for every browser that uses it, and keeps a shared cache of rewritten scripts: the relay rewrites the scripts browsers send it with scramjet's own build (never taking a rewrite from a browser), so a browser with an empty cache skips the rewrites of scripts anyone loaded before. This is by far the fastest option. The catch: the dev server sees your traffic in plaintext, so only use it with a server you run yourself (your machine, your Codespace). See `devrelay.ts`.
- **Libcurl** / **Epoxy**: TLS happens inside the page (in wasm) and the server only forwards encrypted bytes over wisp. Slower, but the server never sees your traffic.

Relay and wisp share one port (4142 by default; the relay is at `/relay`), so forwarding that port is enough for both.

#### Benchmark

`pnpm --filter runway bench` loads real sites directly in Chromium and through scramjet (the relay transport, in controller worker mode), cold, and prints the median load time of each with the ratio. It includes a game on CrazyGames, timed until the game has drawn its first screen. It serves scramjet itself from the built packages, so run `pnpm build` first; `--sites a,b`, `--reps n` and `--out file.jsonl` narrow and record a run. The relay's caches persist for the run, like a proxy server's, so later reps of a site show what a returning visitor (or anyone after the first) gets.

#### Controller worker mode

`new Controller({ serviceworker, worker: { scripts, transport, setupFrame } })` runs request handling (transport, cookies, rewriting) in a dedicated worker instead of on the page. Proxied frames are same-origin with the page that hosts them, so they share its main thread. Without a worker, every request waits whenever the site runs script or lays out. `transport` and `setupFrame` are function sources (functions are serialized with `toString`) that run in the worker after `scripts` load. Fetch hooks tapped on the page's frames don't run in this mode; install those plugins in `setupFrame` instead. After changing `controller.scramjetConfig` in place, call `controller.pushConfig()`. The worker hands big scripts, and whole documents where the browser can move streams between threads, to a few rewriter threads (`controller.rewriter.js`), so it keeps answering the page's other requests while they're rewritten.

#### Warm-up

Before `controller.wait()` resolves, the controller loads a made-up site in a hidden frame. It is served by the controller itself and never touches the network (`packages/controller/src/warmup.ts`). That way the first real page isn't rewritten and booted by cold JavaScript. Once the frame has loaded, every thread that rewrites documents runs the rewriters some more on a small made-up page, while the controller waits for V8 to finish optimizing. Without the warm-up, the first site loaded after startup took up to ~60% longer than the same site loaded second. The warm-up adds about a second to startup, once. Pass `warmup: false` to the `Controller` to skip it.
