import dotenv from 'dotenv';
import os from 'os';
import path from 'path';

// Environment abstraction for testing
export const getEnv = () => {
  // In production, this would return process.env
  // In tests, this will be mocked
  return typeof process !== 'undefined' ? process.env : {};
};

export const getProtectedEnv = () => {
  const env = getEnv();
  return {
    NODE_ENV: env.NODE_ENV,
    INFISICAL_ENV: env.INFISICAL_ENV,
    INFISICAL_TOKEN: env.INFISICAL_TOKEN,
    INFISICAL_PROJECT_ID: env.INFISICAL_PROJECT_ID
  };
};

// Export environment variables for direct access (mockable in tests)
export const { 
  NODE_ENV = getEnv().NODE_ENV || 'development',
  INFISICAL_ENV = getEnv().INFISICAL_ENV,
  INFISICAL_TOKEN = getEnv().INFISICAL_TOKEN,
  INFISICAL_PROJECT_ID = getEnv().INFISICAL_PROJECT_ID,
  API_ID = getEnv().API_ID,
  API_HASH = getEnv().API_HASH,
  BOT_TOKEN = getEnv().BOT_TOKEN,
  OWNER_ID = getEnv().OWNER_ID
} = getEnv();

// Rest of the original code can import and use these instead of process.env directly