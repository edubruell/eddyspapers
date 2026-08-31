import { Hono } from "hono";
import { apiReference } from "../docs/reference.js";

// GET /docs — the public API reference (src/docs/reference.ts). Ungated like /corpus/guide:
// it carries no corpus data and no user data, and the caller who most needs it is the one
// who has not worked out the auth header yet.
export const docsRoute = new Hono();

docsRoute.get("/", (c) => c.json(apiReference()));
