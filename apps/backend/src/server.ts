import { buildApp } from './app.js';
import { config } from './config/index.js';

const app = buildApp();

async function start(): Promise<void> {
  try {
    await app.listen({
      port: config.port,
      host: config.host,
    });

    app.log.info(
      `ATLAS backend service listening on http://${config.host}:${config.port} in ${config.nodeEnv} mode`
    );
  } catch (err) {
    app.log.error(err, 'Failed to start ATLAS backend service');
    process.exit(1);
  }
}

// Graceful shutdown handling
const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

for (const signal of signals) {
  process.on(signal, async () => {
    app.log.info(`Received ${signal}. Gracefully shutting down ATLAS backend...`);
    try {
      await app.close();
      app.log.info('ATLAS backend closed cleanly.');
      process.exit(0);
    } catch (err) {
      app.log.error(err, 'Error occurred during ATLAS backend shutdown');
      process.exit(1);
    }
  });
}

// Process-level uncaught handlers
process.on('unhandledRejection', (reason) => {
  app.log.error({ reason }, 'Unhandled Promise Rejection detected');
});

process.on('uncaughtException', (err) => {
  app.log.fatal(err, 'Uncaught Exception detected');
  process.exit(1);
});

start();

