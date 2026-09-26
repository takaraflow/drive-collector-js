export const trace = {
  getActiveSpan: () => ({
    addEvent: () => {},
    setStatus: () => {},
    setAttribute: () => {},
    recordException: () => {},
  }),
  setSpan: () => ({}),
};

export const context = {
  active: () => ({}),
  with: (ctx, fn) => fn(),
};