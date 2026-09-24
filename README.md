# 干涉相位展开台（Phase Unwrap Station）

纯前端（React + TypeScript + Vite）的二维包裹相位展开裁决台。干涉仪给出的包裹相位只落在
一个周期内；逐点选择最近周期会在二维表面留下不真实的折返。本工具在严格约束下，按多级目标
裁决每格的**圈数**，得到真实相位。

## 模型

每格真实相位

```
Φ(i,j) = 读数(i,j) + 圈数(i,j) × 周期 P
```

可编辑/导入 **2–24 行、2–4 列** 的整数读数矩阵，并设置：

| 项 | 含义 |
| --- | --- |
| 周期 P | 正整数 |
| 圈数区间 [L, U] | 全局圈数范围，**至多包含 3 个连续整数** |
| 相邻跳变上限 C | 任意横/纵相邻格须满足 `|ΔΦ| ≤ C × P`（C 以圈数计） |
| 锚点 | 指定某一格的真实圈数，真实相位由此锚定 |

### 硬约束（必须全部满足）

1. 锚点格圈数等于指定值；
2. 每格圈数 ∈ [L, U]（锚点圈数也必须落在区间内）；
3. 全部横、纵相邻对满足跳变上限。

### 裁决目标（按优先级逐级最小化）

1. **所有横纵连续三格的二阶差分绝对值之和**（曲率，抑制折返）；
2. **所有横纵相邻差绝对值之和**（总变差）；
3. 仍并列时，取**行优先圈数序列字典序最小者**。

满足前两项目标最优的并列解若不止一个，页面额外展示**第二小字典序见证**。

### 无解与非法反馈

- 非法单元（非整数读数）、非法参数均**按行列/字段定位**，点击定位可跳到对应输入；
- 无解时分两类定位：
  - **冲突相邻边**：该边在两格的任意圈数组合下都无法满足跳变上限，列出并在矩阵标红；
  - **首个失败格**：单边都可行但约束传播后无解，报出行优先传播中首个不相容位置。
- 任何输入变化都会**立即撤下旧结果**（计算在 Web Worker 中进行，旧任务即刻终止）。

## 求解算法

按行优先逐格赋值的**前沿动态规划 + 双目标 Pareto 剪枝**：

- 前沿状态只保留最近两行的圈数（列数 ≤ 4，状态域 ≤ 3^8）；
- 每格加入时增量累计横向、纵向一阶差与二阶差，并即时校验左、上两条边；
- 同一前沿状态下，严格劣势的 `(二阶和, 一阶和)` 分组整体淘汰；等目标分组仅保留圈数前缀
  字典序最小的两条（同状态未来决策完全一致，第三名不可能成为全局前二）；
- 终点取 `(二阶和, 一阶和)` 最优组，按完整圈数序列排序给出最小解与第二小见证。

24×4、三整数圈数域规模下实测耗时约 1 秒内（Worker 后台执行）。

## 本地开发

```bash
npm ci          # 或 npm install
npm test        # vitest：求解器单测、DP 对暴力枚举的随机交叉验证、界面测试
npm run build   # tsc 类型检查 + vite 生产构建到 dist/
npm run dev     # 本地开发服务器
npm run preview # 预览构建产物
```

## Docker

多阶段构建：`node:22-alpine` 内测试并构建静态产物，`nginx:1.27-alpine` 纯静态托管。

```bash
# 构建并启动常驻站点（默认宿主机 8080 端口）
docker compose up -d --build web

# 自定义宿主机端口
HOST_PORT=9090 docker compose up -d web
# 或复制 .env.example 为 .env 修改 HOST_PORT
```

健康检查：

- 镜像内置 `HEALTHCHECK`，Compose 也声明了 `healthcheck`；
- 探活端点 `GET /healthz` 返回纯文本 `ok`（HTTP 200）。

### verify 一次性服务

```bash
docker compose build verify
docker compose up --build verify   # 或 docker compose run verify
```

`verify` 会等待 `web` 健康后，依次执行：

1. 代码测试（`npm test`）；
2. 构建检查（`npm run build`）；
3. HTTP 冒烟（经 compose 内网校验 `http://web/healthz` 与首页内容）；

全部通过打印 `VERIFY OK` 并**以退出码 0 自行退出**；任一步失败则以非零退出码报告
（`set -eu` + Compose 的退出码透传）。它不会常驻。

## 目录结构

```
src/
  solver/solver.ts        类型、输入校验、DP 求解器、无解定位
  solver/solver.test.ts   求解器测试（含暴力枚举交叉验证、规模性能）
  solver/solver.worker.ts Web Worker 包装
  useUnwrap.ts            即时撤下 + Worker 调度 Hook
  App.tsx / App.test.tsx  界面与组件测试
  main.tsx / styles.css
public/healthz            健康检查端点静态文件
Dockerfile                builder/runtime 多阶段
nginx.conf                静态托管 + /healthz
docker-compose.yml        web（常驻）+ verify（一次性）
```
