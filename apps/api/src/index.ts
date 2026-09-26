import { Hono } from "hono";
import { prettyJSON } from "hono/pretty-json";

const app = new Hono();
app.use("*", prettyJSON());

app.get("/", (c) => {
  return c.json({
    Hello: "World",
  });
});

export default app;
