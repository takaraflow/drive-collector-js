import crypto from "node:crypto";

function safeCompare(a, b) {
    const aBuf = Buffer.from(a);
    const bBuf = Buffer.from(b);
    if (aBuf.length !== bBuf.length) {
        return false;
    }
    return crypto.timingSafeEqual(aBuf, bBuf);
}

console.log(safeCompare("hello", "hello"));
console.log(safeCompare("hello", "world"));
console.log(safeCompare("hello", "helloworld"));
