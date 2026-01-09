export const normalizeNodeEnv = function(nodeEnv) {
    'use strict';
    
    if (nodeEnv == null || nodeEnv === '') {
        return 'dev';
    }
    
    const env = String(nodeEnv).toLowerCase();
    
    if (env === 'development') {
        return 'dev';
    }
    if (env === 'production') {
        return 'prod';
    }
    if (env === 'staging' || env === 'pre' || env === 'preview') {
        return 'pre';
    }
    if (env === 'test') {
        return 'test';
    }
    if (env === 'prod') {
        return 'prod';
    }
    if (env === 'dev') {
        return 'dev';
    }
    
    return 'dev';
};

export const mapNodeEnvToInfisicalEnv = function(nodeEnv) {
    'use strict';
    
    const normalized = normalizeNodeEnv(nodeEnv);
    
    if (normalized === 'dev') {
        return 'dev';
    }
    if (normalized === 'prod') {
        return 'prod';
    }
    if (normalized === 'pre') {
        return 'pre';
    }
    if (normalized === 'test') {
        return 'dev';
    }
    
    return 'dev';
};
