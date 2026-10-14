# PWA support (backlog)

Status: proposed, not started.

Goal: an xzor app can be installed and keeps working offline, configured in one place and generated at build time like DI and routing. Nothing is added to apps that don't ask for it.

## Shape

```ts
// main.ts
@Mount(Routes, "app")
@Pwa({ name: "Todos", shortName: "Todos", themeColor: "#0b0e1a", icons: ["icons/192.png", "icons/512.png"] })
export class Application implements IApplication {}
```

`@Pwa` comes from `@source-crafter/xzor-runtime` and does nothing at runtime, like `@Singleton`. The build reads it next to `@Mount` (same analysis pass) and writes:

- `dist/manifest.webmanifest`: name, icons, colors, `display: "standalone"`, `start_url` and `scope` taken from `<base href>` (so GitHub Pages sub-paths work).
- `dist/sw.js`: a small, dependency-free service worker. It precaches the build output listed by the bundler, serves navigations from the cached `index.html` (the SPA fallback offline), and uses stale-while-revalidate for other same-origin GETs. The cache name carries the build hash; activation deletes older caches.
- Registration in the generated entry: `navigator.serviceWorker.register(base + "sw.js", { scope: base })`, skipped under `xzor build --watch` so development never serves stale code.

## Steps

1. **Content-hashed assets**: `main.<hash>.js` and `styles.<hash>.css`, with `index.html` rewritten to point at them. This alone fixes stale bundles after a deploy (seen on the docs site) and gives the service worker a precise precache list.
2. **`@Pwa` analysis and manifest**: parse the options in `di.ts` (with diagnostics on the decorator: missing icons, invalid colors), emit the manifest and the `<link rel="manifest">` / `theme-color` tags.
3. **Service worker**: generate `sw.js` from the precache list; navigation fallback; versioned cache cleanup.
4. **Updates**: the runtime exposes `pwa.updateAvailable` (a cascading value) and `pwa.update()` so an app can show "A new version is available" and reload into it.
5. **Docs site**: turn it on for the docs site as the first user.

## Tests

- The manifest and `sw.js` content for given options (unit, in `src/`).
- Hashed names are stable for unchanged inputs and change when the bundle changes.
- A Bun.serve end-to-end check with a real browser (Playwright): install prompt criteria met, offline reload of a deep link renders the page, a new build triggers `updateAvailable`.
- No `@Pwa`: output byte-identical to today.

## Open questions

- Icons: require them (simplest) or generate sizes from one image (needs an image library; conflicts with zero dependencies).
- Offline data for services (IndexedDB helpers) stays out of scope; apps can do it in their services.
