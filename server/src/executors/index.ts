import type { ServerConfig } from "../config";
import { createBrowserbaseExecutor, type CdpConnector } from "./browserbase";
import { createComposioExecutor } from "./composio";
import type { HostLookup } from "./netguard";
import { createStubExecutor } from "./stub";
import type { ExecutorMode, LoopExecutor } from "./types";

export interface ExecutorDeps {
  /** Test seams: the HTTP layer of both executors and the CDP connector. */
  fetch?: typeof fetch;
  connect?: CdpConnector;
  /** DNS resolver of the SSRF guard. Tests inject one so they never touch DNS. */
  lookup?: HostLookup;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** The real executor when its keys are configured, otherwise the simulated stub with the same interface. */
export function createExecutors(config: ServerConfig, deps: ExecutorDeps = {}): Record<ExecutorMode, LoopExecutor> {
  const { browserbase, composio } = config;
  return {
    parallel: browserbase
      ? createBrowserbaseExecutor({ credentials: browserbase, concurrency: browserbase.concurrency, publicDemoUrl: config.publicDemoUrl, ...deps })
      : createStubExecutor("parallel", deps.now),
    api: composio ? createComposioExecutor({ settings: composio, fetch: deps.fetch, now: deps.now }) : createStubExecutor("api", deps.now),
  };
}

export * from "./types";
export { compile, type CompileResult, type CompiledTool } from "./composio";
