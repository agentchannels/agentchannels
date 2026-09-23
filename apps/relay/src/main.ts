import { ConfigurationError, configFromEnvironment } from "./config.ts";
import { openDatabase, SchemaError } from "./database.ts";
import { startRelay } from "./server.ts";
import { RelayStore } from "./store.ts";

function run(): void {
  const config = configFromEnvironment(process.env);
  const db = openDatabase(config.databasePath);
  const relay = startRelay(config, new RelayStore(db));
  console.log(
    `AgentChannels relay listening on ${config.hostname}:${String(relay.server.port)}`,
  );
  const shutdown = (): void => {
    void relay.stop().finally(() => {
      db.close();
      process.exit(0);
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

try {
  run();
} catch (error) {
  if (error instanceof ConfigurationError || error instanceof SchemaError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
