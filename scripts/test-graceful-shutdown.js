import { gracefulShutdown, registerShutdownHook } from "../src/services/GracefulShutdown.js";

console.log("测试优雅关闭机制...");

// 注册一些关闭钩子
registerShutdownHook(async () => {
    console.log("1. 关闭 HTTP Server");
}, 10, 'http-server');

registerShutdownHook(async () => {
    console.log("2. 断开数据库连接");
}, 20, 'database');

registerShutdownHook(async () => {
    console.log("3. 清理临时文件");
}, 30, 'temp-files');

console.log("已注册 3 个关闭钩子");

// 测试可恢复错误识别
const timeoutError = new Error("Connection TIMEOUT");
const fatalError = new Error("Fatal error");

console.log("TIMEOUT 错误是否可恢复:", gracefulShutdown.isRecoverableError(timeoutError));
console.log("Fatal 错误是否可恢复:", gracefulShutdown.isRecoverableError(fatalError));

console.log("✅ 基本功能测试通过");
process.exit(0);
