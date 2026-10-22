import { createApp } from './app';
import { loadConfig } from './config';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createApp({ config });
  await app.listen({ host: config.host, port: config.port });
  app.log.info({ dataDir: config.dataDir }, 'cognitive-atrium server started');
}

main().catch((error) => {
  console.error('server failed to start', error);
  process.exit(1);
});
