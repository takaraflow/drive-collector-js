async function executeRequest(fn) {
    if (fn === 1) return { result: 'res1' };
    if (fn === 2) throw new Error('batch error');
}
const requestFns = [1, 2];
const len = requestFns.length;
const results = new Array(len);
let currentIndex = 0;

const worker = async () => {
    while (currentIndex < len) {
        const index = currentIndex++;
        const fn = requestFns[index];

        try {
            const result = await executeRequest(fn);
            results[index] = { index, result };
        } catch (error) {
            results[index] = { index, error };
        }
    }
};

await worker();

const finalResults = results.map(item => {
    if (item.error) {
        return {
            index: item.index,
            error: item.error.message || 'Unknown error'
        };
    }
    // previously `return item.result;` which is WRONG since the old map returned `{ index, result }` object!
    return item;
});
console.log(finalResults);
