export const resolvePaths = (baseDir, inputs) => {
    return inputs.map(input => {
        if (input.startsWith('/')) return input;
        return `${baseDir}/${input.replace(/^\.\//, '')}`;
    });
};

export const shouldIgnore = (path, ignoreRules) => {
    return ignoreRules.some(rule => {
        const regexPattern = rule
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.');
        const regex = new RegExp('^' + regexPattern + '$');
        return regex.test(path);
    });
};

export const matchPattern = (path, pattern) => {
    const regexPattern = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    const regex = new RegExp('^' + regexPattern + '$');
    return regex.test(path);
};
