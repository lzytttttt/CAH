/** Seed the Demo namespace (data/demo) with the built-in synthetic scenario. */
import { loadConfig } from '../apps/server/src/config';
import { RuntimeManager } from '../apps/server/src/runtime-manager';

async function main(): Promise<void> {
  const config = loadConfig();
  const manager = new RuntimeManager(config, (message, details) => {
    console.log(`[seed] ${message}`, details ?? '');
  });
  try {
    await manager.init();
    const demo = manager.runtime('demo');
    const tasks = await demo.storage.listTasks();
    const sources = tasks[0] ? await demo.storage.listSources(tasks[0].id) : [];
    console.log(`演示数据目录：${config.dataDir}/demo`);
    console.log(`演示任务：${tasks.length} 个；来源资料：${sources.length} 份`);
    console.log('提示：Demo 为只读演示工作区，不会调用真实模型。运行 `pnpm dev` 后访问 http://127.0.0.1:4310 。');
  } finally {
    await manager.shutdown();
  }
}

main().catch((error) => {
  console.error('seed:demo failed', error);
  process.exit(1);
});
