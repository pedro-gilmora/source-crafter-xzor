import { Endpoints, Get } from "@source-crafter/xzor-runtime/server";

// Outside the @Run file's folder: not an endpoint of the app.
@Endpoints("/stray")
export class Stray {
  @Get
  all(): string[] { return []; }
}
