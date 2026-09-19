import { serve } from "@hono/node-server";
import { createApp } from "./app";

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: createApp().fetch, port }, () => {
  console.log(`[ghost] prediction server on http://localhost:${port}`);
});
