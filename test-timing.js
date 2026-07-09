import crypto from "node:crypto";

function hasValidInstanceSecret(headerSecret, configuredSecret) {
    if (typeof headerSecret !== 'string' || typeof configuredSecret !== 'string') {
        return false;
    }

    const header = headerSecret.trim();
    const secret = configuredSecret.trim();

    if (header === '' || secret === '') return false;

    const bufHeader = Buffer.from(header);
    const bufSecret = Buffer.from(secret);

    if (bufHeader.length !== bufSecret.length) {
        return false;
    }

    return crypto.timingSafeEqual(bufHeader, bufSecret);
}

console.log(hasValidInstanceSecret('test', 'test'));
console.log(hasValidInstanceSecret('test', 'test2'));
console.log(hasValidInstanceSecret('test2', 'test'));
console.log(hasValidInstanceSecret('', ''));
console.log(hasValidInstanceSecret(' ', ' '));
