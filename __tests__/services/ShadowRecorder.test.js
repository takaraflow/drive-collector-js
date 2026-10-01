import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import {
    extractObservation,
} from "../../src/services/ShadowRecorder.js";
import {
    computeFingerprint,
    extractTypeId,
} from "../../src/domain/shadow-fingerprint.js";

// gramjs 的类是 Proxy 生成的,必须走包入口 + createRequire,
// 直接 import 子文件会因循环依赖炸掉。
const require = createRequire(import.meta.url);
const { Api } = require("telegram");

/**
 * 提取器的测试。
 *
 * 之前只有跨语言向量锁住了 computeFingerprint 这个格式化器,
 * extractObservation 零覆盖 —— 于是「update.message 是字符串」
 * 这个 bug 能一直存在而测试全绿。格式化器一致 ≠ 数据一致。
 */
describe("ShadowRecorder.extractObservation", () => {
    describe("message 是对象(updateNewMessage 系)", () => {
        it("应提取文本长度", () => {
            const u = new Api.UpdateNewMessage({
                message: new Api.Message({
                    id: 1,
                    message: "hello world",
                    media: undefined,
                }),
            });
            const obs = extractObservation(u);
            expect(obs).not.toBeNull();
            expect(obs.textLen).toBe(11);
            expect(obs.hasMedia).toBe(false);
        });

        it("应识别媒体", () => {
            const u = new Api.UpdateNewMessage({
                message: new Api.Message({
                    id: 2,
                    message: "",
                    media: new Api.MessageMediaPhoto({ photo: {} }),
                }),
            });
            const obs = extractObservation(u);
            expect(obs.hasMedia).toBe(true);
        });

        it("应提取媒体组 ID", () => {
            const u = new Api.UpdateNewMessage({
                message: new Api.Message({
                    id: 3,
                    message: "",
                    media: undefined,
                    groupedId: 987654,
                }),
            });
            const obs = extractObservation(u);
            expect(String(obs.groupId)).toBe("987654");
        });

        it("非媒体组应为空串", () => {
            const u = new Api.UpdateNewMessage({
                message: new Api.Message({ id: 4, message: "", media: undefined }),
            });
            expect(extractObservation(u).groupId).toBeNull();
        });
    });

    // 这组是踩过的坑:这些 update 的 message 字段就是【字符串】。
    // 早先用 `update.message || update` 去读 message.media,
    // 结果 undefined —— 文本被静默算成 0 字符,指纹系统性偏差。
    describe("message 是字符串(踩过的坑)", () => {
        it("updateShortMessage 的文本不能被吞掉", () => {
            const u = new Api.UpdateShortMessage({
                message: "hi there this is text",
                pts: 1,
                ptsCount: 1,
            });
            expect(typeof u.message).toBe("string");

            const obs = extractObservation(u);
            expect(obs).not.toBeNull();
            // 字符串本身不是 Api.Message,所以没有可提取的 message 字段,
            // textLen 应为 0 —— 但绝不能因此崩掉或读出垃圾。
            expect(obs.textLen).toBe(0);
            expect(obs.hasMedia).toBe(false);
        });

        it("updateShortChatMessage 同理", () => {
            const u = new Api.UpdateShortChatMessage({
                message: "chat text",
                chatId: 1,
                pts: 1,
                ptsCount: 1,
            });
            const obs = extractObservation(u);
            expect(obs).not.toBeNull();
            expect(obs.textLen).toBe(0);
        });

        it("updateServiceNotification 同理", () => {
            const u = new Api.UpdateServiceNotification({
                message: "NOTIF TEXT",
                media: new Api.MessageMediaPhoto({ photo: {} }),
                pts: 1,
                ptsCount: 1,
            });
            const obs = extractObservation(u);
            expect(obs).not.toBeNull();
            expect(obs.textLen).toBe(0);
        });
    });

    describe("非 Telegram update 应被拒", () => {
        it("没有 CONSTRUCTOR_ID 的对象(本地合成事件)返回 null", () => {
            // gramjs 的 UpdateConnectionState 没有 CONSTRUCTOR_ID。
            // 它不是 Telegram update,记进去只会造出 Go 侧永远没有的噪声。
            expect(extractObservation({ date: 1, ready: true })).toBeNull();
        });

        it("null / 非对象返回 null", () => {
            expect(extractObservation(null)).toBeNull();
            expect(extractObservation(undefined)).toBeNull();
            expect(extractObservation("string")).toBeNull();
            expect(extractObservation(42)).toBeNull();
        });
    });

    describe("与 Go 侧的对齐前提", () => {
        it("TypeID 必须是真实 CONSTRUCTOR_ID,而非 VirtualClass", () => {
            const u = new Api.UpdateNewMessage({ message: new Api.Message({ id: 1 }) });
            expect(u.constructor.name).toBe("VirtualClass");
            expect(extractTypeId(u)).toBe("1f2b0afd");
            expect(extractTypeId(u)).not.toBe("");
        });

        it("每个可观察的 update 都要有非空 TypeID", () => {
            const updates = [
                new Api.UpdateNewMessage({ message: new Api.Message({ id: 1 }) }),
                new Api.UpdateBotCallbackQuery({ queryId: 1 }),
                new Api.UpdateShortMessage({ message: "x", pts: 1, ptsCount: 1 }),
            ];
            for (const u of updates) {
                expect(extractTypeId(u), u.constructor.name).not.toBe("");
            }
        });
    });
});

describe("ShadowRecorder 指纹一致性", () => {
    it("同样的输入两次必须算出同一个指纹", () => {
        const u = new Api.UpdateNewMessage({
            message: new Api.Message({ id: 1, message: "abc" }),
        });
        const a = computeFingerprint(extractObservation(u));
        const b = computeFingerprint(extractObservation(u));
        expect(a).toBe(b);
    });

    it("不同文本长度必须算出不同指纹", () => {
        const mk = (text) => computeFingerprint(extractObservation(
            new Api.UpdateNewMessage({
                message: new Api.Message({ id: 1, message: text }),
            })
        ));
        expect(mk("a")).not.toBe(mk("ab"));
    });
});