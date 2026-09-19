import { serve, type ServerType } from "@hono/node-server";
import { createApp } from "./app";
import type { ServerConfig } from "./config";

/** Binds config.host (loopback by default): without a hostname Node listens on every interface, i.e. the whole LAN. */
export function startServer(config: ServerConfig, onListening?: (port: number) => void): ServerType {
  return serve({ fetch: createApp(config).fetch, port: config.port, hostname: config.host }, (info) => onListening?.(info.port));
}
