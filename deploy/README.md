# 部署与运维

生产域名：`https://sbhot.voee.de`；应用绑定 `127.0.0.1:16611`。
通过 Termark 资产 `vps.town` 管理。现有 Cloudflare 路由已转发此端口，不修改其他 Nginx 站点。

## 目录和服务

- `/opt/sbhot/releases/<version>/`：只读发布文件（backend、deploy、两个脚本文件）。
- `/opt/sbhot/current`：当前发布的软链接；发布时创建新目录再原子切换。
- `/opt/sbhot/venv`：Python 3.11 虚拟环境。
- `/var/lib/sbhot/stats.sqlite3`：持久化 SQLite WAL 数据库，不随代码更新覆盖。
- `/var/lib/sbhot/backups/`：每日 UTC 04:15 在线备份，保留7份。
- `sbhot-web.service`、`sbhot-collector.service`、`sbhot-backup.timer`：低权限 sbhot 账户、开机启动、失败重启。

## 检查

```sh
systemctl status sbhot-web sbhot-collector --no-pager
curl -fsS http://127.0.0.1:16611/healthz
curl -fsS https://sbhot.voee.de/api/status
journalctl -u sbhot-collector -n 50 --no-pager
systemctl start sbhot-backup.service
```

healthz 的 `ok` 代表服务可读数据库，`ready` 代表首次完整扫描成功；不代表已经积累7天。`stale` 表示完整扫描超过3小时未完成或尚未完成。API各榜 `warming_up`、`coverage_gap`、`observed_seconds` 分别说明窗口未完整、扫描缺口和积累时长。

本地可执行 `node tests/live.cjs` 做显式联网的只读冒烟检查：实际访问生产四周期API及元数据，在浏览器中检查跨域通信和积累状态；它不会自动进入CI，避免每次提交都访问生产。

## 发布

先跑 Node 与 Python 测试、浏览器检查。将 backend、deploy 和脚本打包经 `termark upload` 上传到新 release 目录；确认依赖、脚本头部和元数据一致。执行在线备份后，将 `current` 原子指向新目录，重启两个服务，检查 HTTPS 四个API和版本文件。GitHub main 同步同一客户端版本供旧用户升级到服务器更新源。后续仅发布 GitHub 不会自动部署服务器。

## 回滚

保留前一个 release。将 `current` 原子切回上一目录后重启服务；不要删除或覆盖数据库。若确需恢复备份，应先停止采集和Web，保留当前数据库及WAL，使用已验证的SQLite备份恢复，恢复后API会如实显示统计缺口。

## 采集口径与负载

全部公开主题按 /new/ 分页遍历（当前约174页），两次请求之间至少2秒；每轮完整扫描结束后1小时再启动下一轮。最近活跃列表每5分钟扫描到上一轮成功时间之前，再读取最新帖子第一页；完整扫描期间可穿插活跃扫描。遇错误等待60秒并从持久化分页继续。5000页安全上限触发失败，不能标记为已完成。

只读取匿名可见的列表，不请求主题详情来人为增加浏览量，不读取私有页面。被删除、不可见主题无法观测；滑动分页及计数变化存在采样误差。浏览/回复增量归属“观察到变化”的时刻，而非精确访问发生时刻。只有首次完整扫描后才开始完整窗口计时。禁止将历史累计计数直接当成过去1小时/7天增量。

## v2.1 混合模式

日/月榜仅使用官方榜单，每15分钟同步两个页面并共享缓存，不进行本地窗口聚合。官方缓存失败保留最后成功值，API source=official 与刷新错误独立于自建基线。实时/周榜共用采集；全量周期3600秒，活跃300秒，增量保留9天、全量扫描记录10天。官方源路径 /pages/top/ 和 /pages/top/30d/。
