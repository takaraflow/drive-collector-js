import Database from 'better-sqlite3';

/**
 * 创建内存数据库用于集成测试
 * 模拟D1数据库的行为，但使用本地SQLite
 * @returns {Database} SQLite内存数据库实例
 */
export function createTestDatabase() {
  const db = new Database(':memory:');

  // 创建必要的表结构
  createTables(db);

  return db;
}

/**
 * 创建测试数据库表
 * @param {Database} db
 */
function createTables(db) {
  // tasks表 - 基于实际TaskRepository使用的字段
  db.exec(`
    CREATE TABLE tasks (
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
    CREATE TABLE drives (
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
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
    )
  `);

  // sessions表
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      expires_at INTEGER
    )
  `);
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
        console.error('Mock D1 fetchAll error:', error);
        return [];
      }
    },

    fetchOne: async (sql, params = []) => {
      try {
        const stmt = db.prepare(sql);
        return stmt.get(params) || null;
      } catch (error) {
        console.error('Mock D1 fetchOne error:', error);
        return null;
      }
    },

    run: async (sql, params = []) => {
      try {
        const stmt = db.prepare(sql);
        return stmt.run(params);
      } catch (error) {
        console.error('Mock D1 run error:', error);
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
 * 清理测试数据库
 * @param {Database} db
 */
export function cleanupTestDatabase(db) {
  if (db && db.open) {
    db.close();
  }
}