// The script `xzor dev` serves at `/__xzor/hot.js`, before the app's modules: it installs the registry
// the hot bundle registers its components into, and applies what the dev server sends.
import { installHot } from "./hot";

const hot = installHot(globalThis);
new EventSource("/__xzor/reload").onmessage = (e: MessageEvent<string>) => {
  if (e.data === "reload") location.reload();
  else hot.apply(JSON.parse(e.data).hot);
};
