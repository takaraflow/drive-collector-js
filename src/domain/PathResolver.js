export const resolvePaths = (baseDir, inputs) => {
    return inputs.map(input => {
        if (input.startsWith('/')) return input;
        return `${baseDir}/${input.replace(/^\.\//, '')}`;
    });
};

export const shouldIgnore = (path, ignoreRules) => {
    return ignoreRules.some(rule => {
        const regex = new RegExp('^' + rule.replace(/\*/g, '.*') + '$');
        return regex.test(path);
    });
};

export const matchPattern = (path, pattern) => {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(path);
};
