/**
 * 路径工具模块
 * 处理路径规范化和映射
 */

/**
 * 路径映射 - 将契约路径映射到实际路径
 */
const PATH_MAP = {
  '/api/tasks/download-tasks': '/api/tasks/download',
  '/api/tasks/upload-tasks': '/api/tasks/upload',
  '/api/tasks/media-batch': '/api/tasks/batch'
};

/**
 * 规范化路径
 * @param {string} pathname - 原始路径
 * @returns {string} 规范化后的路径
 */
function normalizePath(pathname) {
  return PATH_MAP[pathname] || pathname;
}

export {
  PATH_MAP,
  normalizePath
};