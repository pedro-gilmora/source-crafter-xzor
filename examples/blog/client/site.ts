import "@source-crafter/xzor-ui";
import "./app.css";
import { viewTransitions } from "@source-crafter/xzor-runtime";

// The views import this module, so the kit, the blog's CSS and the transitions reach the browser bundle.
viewTransitions(true);

export const siteName = "Field Notes";
