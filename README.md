# 烧饼论坛热榜 2.0.0

**[安装 / 更新脚本](https://sbhot.voee.de/shaobing-hot.user.js)** · [服务首页](https://sbhot.voee.de/) · [采集状态](https://sbhot.voee.de/api/status)

烧饼论坛侧栏热榜，后台持续统计公开主题的浏览、回复计数变化。保留 NodeSeek 热榜插件的前十条、展开收起与切换交互。

## 安装与使用

安装 Tampermonkey，打开上面的安装链接，确认安装后刷新 https://sb.sb/。面板位于用户卡片下方，支持明暗主题、浏览/回复双榜和四个时间范围：

| 选项 | 统计范围 |
|---|---|
| 实时 | 最近1小时内观测到的新增浏览/回复 |
| 24小时 | 滚动24小时增量 |
| 周榜 | 滚动7天增量 |
| 30天榜 | 滚动30天增量 |

默认展示10条，展开最多100条。时间范围不足、首次建库、采集中断和数据过期都会明确提示。新服务不能还原启动前的历史增量，完整周榜需要从基线完成后积累7天，30天榜需要积累30天；积累期间可以查看已观测到的增量。

## 数据如何产生

服务器遍历所有匿名可见主题列表建立基线，并持续记录计数差分。活跃主题每5分钟检查，全量分页扫描每轮结束后30分钟再启动。相邻请求至少间隔2秒，失败退避并断点续跑，不通过访问主题详情刷浏览数。

这是**公开计数的定期快照统计**，不是论坛内部事件日志。增量记入被观察到的时刻，窗口边界存在采样误差。私有、删除或已不可见的内容不能完整观测。全站扫描完成不等于全历史可回溯，也不等于官方榜单。

首次读取旧主题只建立基线，不把历史累计值充当今日/周榜热度。重复读取不会重复累计；计数下降不产生负热度。数据保存在服务器 SQLite 中，网页关闭不影响后台采集。客户端每分钟读取缓存API，时间标记显示服务端采集时间。

## 更新已迁移到服务器

- 安装文件：`https://sbhot.voee.de/shaobing-hot.user.js`
- 更新元数据：`https://sbhot.voee.de/shaobing-hot.meta.js`
- 版本检测：烧饼页面运行时每小时检测，跨刷新保存检查时间，油猴菜单可以立即检查。
- GitHub 保留 v2.0.0 迁移版本与源码，旧版可通过旧更新地址取得迁移版；因新增域名权限，Tampermonkey 可能要求确认。也可直接用新链接覆盖安装一次。

在 Tampermonkey 设置的“脚本更新”中开启检查更新与“自动安装”。脚本自身不能修改管理器全局间隔或静默替换已安装源码，实际安装由 Tampermonkey 调度；网页内每小时检测不代表每小时强制安装。休眠/标签挂起后会补查；关闭所有烧饼页面后网页版本检测暂停，管理器的原生更新独立运行。

## 后台接口

只读 HTTPS GET：

- `/healthz`：服务和数据库可读性，`ready` 表示首次全量扫描完成。
- `/api/status`：主题数、最近扫描、分页进度及错误。
- `/api/rankings/realtime`、`daily`、`weekly`、`monthly`：四周期 JSON，包含浏览/回复双榜、采集时间、窗口积累状态。

`warming_up` 代表窗口不足或采集覆盖不完整；`coverage_gap` 标记窗口内完整扫描的长间断；`status.stale` 代表完整扫描超过90分钟没有成功或尚未建立基线。`observed_seconds` 是基线完成后的已积累时长，不会伪装成完整7天/30天。

## 开发与验证

Node.js 22+、Python 3.11+：

```sh
npm ci
pip install -r backend/requirements.txt
npm test
npm run check
python -m unittest discover -s tests -p test_backend.py -v
npx playwright install chromium
node tests/browser.cjs
```

主题列表样本来自2026-11-02公开页面。`rankings.json` 是用主题样本构造的客户端测试数据，不是生产增量统计。测试覆盖基线、增量、重复采集、新帖补记、滚动窗口、中断、断点、持久化、API边界、四周期交互及版本检查。

发布时同步递增脚本头部、`VERSION`、package和lockfile版本，运行 `npm run build:meta`，测试通过后同版本原子部署两个脚本文件。代码提交GitHub不会自动部署服务器。[部署、备份与回滚说明](deploy/README.md)。

原插件作者：https://www.nodeseek.com/space/10539；原 NodeSeek 热榜插件 1.1 声明 MIT，保留来源署名。论坛数据来自 https://sb.sb/。本仓库不包含本地参考助手、服务器凭据或会话记录。
