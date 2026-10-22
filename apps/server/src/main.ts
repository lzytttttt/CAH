import { createApp } from './app';
import { loadConfig } from './config';
import { RuntimeManager } from './runtime-manager';
import { SessionManager } from './session';
import { loadTemplateCatalog } from './templates';

async function main(): Promise<void> {
  const config = loadConfig();
  const manager = new RuntimeManager(config, (message, details) => {
    console.log(`[runtime] ${message}`, details ?? '');
  });
  await manager.init();
  const session = await SessionManager.create(config);
  const catalog = await loadTemplateCatalog(config.repoRoot);
  const app = await createApp({ config, manager, session, catalog });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`收到 ${signal}，正在安全关闭…`);
    try {
      await app.close();
      await manager.shutdown();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      url: `http://${config.host}:${config.port}`,
      dataDir: config.dataDir,
      mode: manager.currentMode,
      sessionTokenFile: config.sessionTokenFile,
      webDist: config.webDistDir,
    },
    'cognitive-atrium server started',
  );
  console.log(`\nCognitive Atrium 已启动： http://${config.host}:${config.port}`);
  console.log(`本地会话令牌文件：${config.sessionTokenFile}`);
  console.log(`当前模式：${manager.currentMode}（可用：${manager.availableModes().join(', ')}）\n`);
}

main().catch((error) => {
  console.error('server failed to start', error);
  process.exit(1);
});
