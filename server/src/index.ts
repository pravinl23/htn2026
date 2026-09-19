import { loadConfig } from "./config";
import { startServer } from "./listen";

const config = loadConfig();
startServer(config, (port) => {
  console.log(`[ghost] prediction server on http://${config.host}:${port} (decisions: ${config.decisionProvider}, text: ${config.textProvider})`);
});
