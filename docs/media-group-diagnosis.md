# Telegram 媒体组无回应诊断

诊断日期：2026-09-06。代码基线：`4a78feb`。本地 GramJS（`telegram`）版本：`2.26.22`，与 `package-lock.json` 一致。

## 已确认的原因

`MediaGroupBuffer._flushBufferWithLock()` 将缓存里的消息编号转换成 `BigInt`，再传给 `client.getMessages()`。GramJS 的 `utils.getInputMessage()` 只把普通 `number` 转换成 `InputMessageID`，不接受 `BigInt`。

真实 SDK 在发送网络请求之前就报错：

```text
Cannot cast 1001 to any kind of InputMessage
```

Telegram 的 [inputMessageID 协议](https://core.telegram.org/constructor/inputMessageID)也明确规定 `id:int`。它与媒体组编号 `groupedId`、用户编号等长整数不是同一种字段。

故障链条：

1. `Dispatcher._handleMediaMessage()` 将有 `groupedId` 的媒体交给缓冲服务。
2. 缓冲到期、远程事件或批量上限触发取回消息。
3. GramJS 拒绝错误类型的消息编号。
4. `_flushBufferWithLock()` 捕获异常，重试三次后删除缓冲，没有通知用户。
5. `TaskManager.addBatchTasks()` 没有执行；其中发送“已接收”的代码自然也没有执行。

Dispatcher 的单文件降级只处理 `add()` 抛出的异常，不能接住已经被缓冲服务捕获的后续失败。单张媒体直接调用 `addTask()`，不经过这处错误转换。

## 哪次改动引入

- `ce7f4aa`（2026-08-04）改为缓存消息编号、处理时重新取消息，同时引入 `BigInt(m.id)`。
- `60e7a3c`（同日）改了聊天目标的保存和恢复方式，保留了错误的消息编号类型。
- 原测试将 `client.getMessages()` 完全模拟为成功，还明确断言编号应该是 `[1001n, 1002n]`，所以没有暴露真实 SDK 的拒绝行为。

这确定了**当前这一处故障**的引入时间，不能据此断定更早的相册故障也是同一个原因。

## 复现与本地修复

新增 `__tests__/integration/media-group-capture.test.js`，调用真实缓冲服务、GramJS 消息迭代器、请求参数转换、请求序列化及 `TaskManager.addBatchTasks()`。缓存、锁、网络响应、消息发送、数据库和队列用内存模拟；使用假时钟和固定数据。

```bash
node_modules/.bin/vitest run __tests__/integration/media-group-capture.test.js --maxWorkers=1
```

修复前连续两次复现：一张图片和一个视频带说明文字，SDK 报错三次，回复次数为零。最小 SDK 对照也得到 `bigint` 失败、`number` 序列化成功。

本地修复只将取消息时的 `BigInt(m.id)` 改为 `Number(m.id)`，并纠正旧测试的参数断言。缓存仍保存字符串，避免引入序列化问题。

修复后四个回归场景通过：本地定时处理、远程事件处理、达到批量上限，以及完整十项相册。验证了回复一次、所有媒体入队及成功后清理缓冲。

扩大验证运行媒体组的三个测试文件，以及 `TaskManager.test.js`、`LinkParser.test.js`、`WebhookRouter.test.js`：**6 个文件、105 项测试全部通过**，单工作进程，总耗时 2.99 秒。`git diff --check` 通过。

## 验证边界

本次验证使用私聊目标，包含图片、视频、说明文字及十项相册。没有连接真实 Telegram、数据库或队列，没有核对生产日志或生产运行的提交，也没有部署。线上是否恢复仍需在部署后用真实相册验证。

失败重试耗尽后缺少用户提示仍是现有行为。本次最小修复消除了已复现的类型错误，没有重新设计通用失败通知或聚合并发策略。
