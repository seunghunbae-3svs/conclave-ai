import { createApp } from "./router.js";
import type { Env } from "./env.js";

const app = createApp();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },
};

export { createApp } from "./router.js";
export type { Env } from "./env.js";
