const createMockFn = () => {
  const fn = function(...args) {
    fn._callCount++;
    fn._callArgs.push(args);
    if (fn._mockRejectError) {
      return new Promise((resolve, reject) => {
        reject(fn._mockRejectError);
      });
    }
    if (fn._mockReturnValues.length > 0) {
      return fn._mockReturnValues.shift();
    }
    return fn._mockReturnValue;
  };
  fn._mockReturnValue = undefined;
  fn._mockFn = undefined;
  fn._mockReturnValues = [];
  fn._mockRejectError = null;
  fn._callCount = 0;
  fn._callArgs = [];
  fn.mockResolvedValue = (value) => { fn._mockReturnValue = Promise.resolve(value); return fn; };
  fn.mockResolvedValueOnce = (value) => { 
    fn._mockReturnValues.push(Promise.resolve(value));
    return fn;
  };
  fn.mockRejectedValue = (error) => { fn._mockRejectError = error; return fn; };
  fn.mockClear = () => { 
    fn._mockReturnValue = undefined; 
    fn._mockReturnValues = [];
    fn._mockRejectError = null;
    fn._callCount = 0;
    fn._callArgs = [];
    return fn; 
  };
  fn.mockImplementation = (impl) => { fn._mockFn = impl; return fn; };
  fn.mockReturnValue = (value) => { fn._mockReturnValue = value; return fn; };
  return fn;
};

const mockRedisInstance = {
  connected: true,
  connect: (() => {
    const fn = createMockFn();
    fn._mockReturnValue = Promise.resolve(undefined);
    return fn;
  })(),
  get: (() => {
    const fn = createMockFn();
    fn._mockReturnValue = Promise.resolve('redis-value');
    return fn;
  })(),
  set: (() => {
    const fn = createMockFn();
    fn._mockReturnValue = Promise.resolve(true);
    return fn;
  })(),
  delete: (() => {
    const fn = createMockFn();
    fn._mockReturnValue = Promise.resolve(true);
    return fn;
  })(),
  listKeys: (() => {
    const fn = createMockFn();
    fn._mockReturnValue = Promise.resolve(['key2']);
    return fn;
  })(),
  getProviderName: (() => {
    const fn = createMockFn();
    fn._mockReturnValue = 'RedisTLS';
    return fn;
  })(),
  getConnectionInfo: (() => {
    const fn = createMockFn();
    fn._mockReturnValue = { provider: 'RedisTLS', tls: true };
    return fn;
  })(),
  destroy: (() => {
    const fn = createMockFn();
    fn._mockReturnValue = Promise.resolve(undefined);
    return fn;
  })()
};

const RedisTLSCache = function() {
  return mockRedisInstance;
};

RedisTLSCache.prototype = mockRedisInstance;

if (typeof global !== 'undefined') {
  global.__cacheMocks = global.__cacheMocks || {};
  global.__cacheMocks.redis = mockRedisInstance;
}

export { RedisTLSCache, mockRedisInstance };
