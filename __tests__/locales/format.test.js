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

    test("should handle null values correctly", () => {
        const template = "User: {{user}}";
        const result = format(template, { user: null });
        expect(result).toBe("User: {{user}}");
    });

    test("should handle boolean false correctly", () => {
        const template = "Status: {{active}}";
        const result = format(template, { active: false });
        expect(result).toBe("Status: false");
    });

    test("should handle empty string correctly", () => {
        const template = "Prefix{{separator}}Suffix";
        const result = format(template, { separator: "" });
        expect(result).toBe("PrefixSuffix");
    });

    test("should use default empty object if vars is not provided", () => {
        const template = "Hello {{name}}!";
        const result = format(template);
        expect(result).toBe("Hello {{name}}!");
    });

    test("should return original template if no placeholders exist", () => {
        const template = "No placeholders here.";
        const result = format(template, { key: "value" });
        expect(result).toBe("No placeholders here.");
    });

    test("should handle keys with numbers and underscores", () => {
        const template = "{{key_1}} and {{key_2}}";
        const result = format(template, { key_1: "first", key_2: "second" });
        expect(result).toBe("first and second");
    });
});
