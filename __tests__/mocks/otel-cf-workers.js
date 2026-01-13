// Mock for @microlabs/otel-cf-workers
export const instrument = (handler, config) => {
  return handler;
};

export const extractConfigFromEnv = (config, env) => {
  // Mock implementation
  config.serviceName = 'lb-worker-js';
  config.exporter = {
    url: 'https://api.axiom.co/v1/traces',
    headers: {
      'Authorization': env.AXIOM_TOKEN ? `Bearer ${env.AXIOM_TOKEN}` : '',
      'X-Axiom-Dataset': env.AXIOM_DATASET || ''
    }
  };
};

export const init = (config) => {
  // Mock implementation
};
