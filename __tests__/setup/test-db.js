import Database from 'better-sqlite3';

// 共享数据库实例 - 在测试套件间复用
let sharedDbInstance = null;
let dbUsageCount = 0;

/**
 * 获取共享的内存数据库实例
 * 首次调用时创建，后续调用返回同一实例
 * @returns {Database} SQLite内存数据库实例
 */
export function getSharedDatabase() {
  if (!sharedDbInstance) {
    sharedDbInstance = new Database(':memory:');
    createTables(sharedDbInstance);
    // 移除 console.log，用 expect.assertions 静默验证
    expect.assertions(0); // 表明无断言期望，静默成功
  }
  dbUsageCount++;
  return sharedDbInstance;
}

/**
 * 创建测试数据库表
 * @param {Database} db
 */
function createTables(db) {
  // tasks表 - 基于实际TaskRepository使用的字段
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      chat_id TEXT,
      msg_id INTEGER,
      source_msg_id INTEGER,
      file_name TEXT,
      file_size INTEGER DEFAULT 0,
      status TEXT DEFAULT 'queued',
      error_msg TEXT,
      created_at INTEGER,
      updated_at INTEGER
    )
  `);

  // drives表
  db.exec(`
    CREATE TABLE IF NOT EXISTS drives (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      config TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      UNIQUE(user_id, provider)
    )
  `);

  // settings表
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
    )
  `);

  // sessions表
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      expires_at INTEGER
    )
  `);
}

/**
 * 为每个测试创建事务包装器
 * 使用事务实现测试隔离，避免数据污染
 * @param {Function} testFn - 测试函数
 * @returns {Function} 包装后的测试函数
 */
export function withTransaction(testFn) {
  return async function () {
    const db = getSharedDatabase();
    const transaction = db.transaction(() => {
      return testFn(db);
    });
    
    try {
      await transaction();
    } finally {
      // 事务结束后自动回滚，保持数据库干净
      db.exec('ROLLBACK');
    }
  };
}

/**
 * 清理数据库状态（但不关闭连接）
 * 用于测试后的数据清理
 */
export function cleanupDatabaseState() {
  if (sharedDbInstance) {
    // 清理所有表数据
    sharedDbInstance.exec(`
      DELETE FROM tasks;
      DELETE FROM drives;
      DELETE FROM settings;
      DELETE FROM sessions;
    `);
  }
}

/**
 * 创建模拟的D1服务
 * @param {Database} db - 测试数据库实例
 * @returns {Object} 模拟的D1服务
 */
export function createMockD1Service(db) {
  return {
    fetchAll: async (sql, params = []) => {
      try {
        const stmt = db.prepare(sql);
        return stmt.all(params);
      } catch (error) {
        // 移除 console.error，抛出错误让测试捕获
        throw new Error(`Mock D1 fetchAll error: ${error.message}`);
      }
    },

    fetchOne: async (sql, params = []) => {
      try {
        const stmt = db.prepare(sql);
        return stmt.get(params) || null;
      } catch (error) {
        // 移除 console.error，抛出错误让测试捕获
        throw new Error(`Mock D1 fetchOne error: ${error.message}`);
      }
    },

    run: async (sql, params = []) => {
      try {
        const stmt = db.prepare(sql);
        return stmt.run(params);
      } catch (error) {
        // 移除 console.error，直接抛出
        throw error;
      }
    },

    batch: async (statements) => {
      const results = [];
      for (const stmt of statements) {
        try {
          const result = await this.run(stmt.sql, stmt.params);
          results.push({ success: true, result });
        } catch (error) {
          results.push({ success: false, error });
        }
      }
      return results;
    }
  };
}

/**
 * 关闭共享数据库实例
 * 在所有测试完成后调用
 */
export function closeSharedDatabase() {
  if (sharedDbInstance) {
    sharedDbInstance.close();
    sharedDbInstance = null;
    dbUsageCount = 0;  // Reset
    // 移除 console.log，静默关闭
  }
}

/**
 * 获取数据库使用统计
 */
export function getDbStats() {
  return {
    instanceExists: !!sharedDbInstance,
    usageCount: dbUsageCount
  };
}
