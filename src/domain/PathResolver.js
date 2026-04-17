export const resolvePaths = (baseDir, inputs) => {
    return inputs.map(input => {
        if (input.startsWith('/')) return input;
        return `${baseDir}/${input.replace(/^\.\//, '')}`;
    });
};

export const shouldIgnore = (path, ignoreRules) => {
    return ignoreRules.some(rule => {
        // Escape regex special characters except *
        const escapedRule = rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp('^' + escapedRule.replace(/\*/g, '.*') + '$');
        return regex.test(path);
    });
};

export const matchPattern = (path, pattern) => {
    // Escape regex special characters except *
    const escapedPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp('^' + escapedPattern.replace(/\*/g, '.*') + '$');
    return regex.test(path);
};
