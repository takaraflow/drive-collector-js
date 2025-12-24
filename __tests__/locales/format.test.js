import { format } from "../../src/locales/zh-CN.js";

describe("format function", () => {
    test("should replace placeholders with values", () => {
        const template = "Hello {{name}}!";
        const result = format(template, { name: "World" });
        expect(result).toBe("Hello World!");
    });

    test("should handle numeric 0 correctly", () => {
        const template = "Count: {{count}}";
        const result = format(template, { count: 0 });
        expect(result).toBe("Count: 0");
    });

    test("should keep placeholder if value is undefined", () => {
        const template = "Count: {{count}}";
        const result = format(template, {});
        expect(result).toBe("Count: {{count}}");
    });

    test("should handle multiple placeholders", () => {
        const template = "{{a}} + {{b}} = {{c}}";
        const result = format(template, { a: 1, b: 2, c: 3 });
        expect(result).toBe("1 + 2 = 3");
    });
});