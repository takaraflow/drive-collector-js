import dotenv from 'dotenv';

// Wrapper for dotenv to enable proper mocking in tests
export const loadDotenv = (options = {}) => {
    return dotenv.config(options);
};

export default {
    config: loadDotenv
};