import { describe, expect, it } from 'vitest';
import {
    buildTaskObjectFromDb,
    resolveStoredTaskSource
} from '../../src/processor/TaskManager/TaskSourceResolver.js';

describe('TaskSourceResolver', () => {
    it('builds a Telegram source from stored metadata without a live message', () => {
        const source = resolveStoredTaskSource({
            id: 'task-1',
            user_id: 'user-1',
            chat_id: 'chat-1',
            msg_id: 11,
            source_msg_id: 22,
            source_ref: JSON.stringify({ chatId: 'chat-1', messageId: 22 }),
            file_name: 'video.mp4',
            file_size: 1234,
            source_type: 'telegram_media'
        });
        const task = buildTaskObjectFromDb({
            id: 'task-1',
            user_id: 'user-1',
            chat_id: 'chat-1',
            msg_id: 11,
            source_msg_id: 22,
            file_name: 'video.mp4'
        }, source);

        expect(source).toEqual({
            sourceType: 'telegram_media',
            sourceRef: { chatId: 'chat-1', messageId: 22 },
            fileInfo: { name: 'video.mp4', size: 1234 }
        });
        expect(task).toMatchObject({
            id: 'task-1',
            sourceMsgId: 22,
            message: null,
            fileInfo: { name: 'video.mp4', size: 1234 }
        });
    });

    it('fails stored Telegram source resolution when message id is absent', () => {
        expect(() => resolveStoredTaskSource({
            id: 'task-1',
            source_type: 'telegram_media',
            source_msg_id: null,
            source_ref: null
        })).toThrow('Source msg missing');
    });
});
