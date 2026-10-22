# 第三方依赖许可清单

本项目自身以 MIT 许可发布（见根目录 `LICENSE`）。运行时与构建依赖的主要许可如下（以安装版本 `package.json` 的 `license` 字段为准；逐项可复核）：

| 依赖 | 版本（锁定） | 许可 |
| - | - | - |
| fastify | 5.12.7 | MIT |
| zod | 4.6.7 | MIT |
| react / react-dom | 18.3.1 | MIT |
| zustand | 5.0.16 | MIT |
| framer-motion | 11.18.2 | MIT |
| lucide-react | 0.577.0 | ISC |
| vite | 6.4.5 | MIT |
| @vitejs/plugin-react | 4.7.0 | MIT |
| tailwindcss / postcss / autoprefixer | 3.4.19 / 8.5.31 / 10.6.1 | MIT |
| typescript | 5.9.3 | Apache-2.0 |
| vitest | 2.1.9 | MIT |
| esbuild | 0.24.2 | MIT |
| tsx | 4.23.15 | MIT |
| playwright（仅测试/验收） | 1.64.1 | Apache-2.0 |
| @types/* | 22.20.5 / 18.3.31 / 18.3.7 | MIT |

说明：
- SQLite 通过 Node.js 内置 `node:sqlite`（SQLite 公共领域）使用，不引入原生编译依赖。
- 构建与运行不使用未列出的外部服务；未引入 Three.js/WebGL、向量数据库、消息中间件或微服务框架。
- 完整依赖树可由 `pnpm list --depth -1 -r` 与 `pnpm-lock.yaml` 复核；如进入正式分发，请在 CI 中加入自动化许可证扫描。
