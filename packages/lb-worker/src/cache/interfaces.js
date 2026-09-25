export class ICacheClient {
  /**
   * @returns {Promise<void>}
   */
  async connect() {}

  /**
   * @returns {Promise<void>}
   */
  async disconnect() {}

  /**
   * @param {string} key
   * @returns {Promise<string | null>}
   */
  async get(key) {}

  /**
   * @param {string} key
   * @param {string} value
   * @param {number} [ttl]
   * @returns {Promise<'OK' | null>}
   */
  async set(key, value, ttl) {}

  /**
   * @param {string} cursor
   * @param {string} match
   * @param {number} count
   * @returns {Promise<[string, string[]]>}
   */
  async scan(cursor, match, count) {}

  /**
   * @returns {Promise<string>}
   */
  async ping() {}
}