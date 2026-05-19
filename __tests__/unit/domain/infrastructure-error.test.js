import { describe, expect, test } from "vitest";
import {
    classifyInfrastructureError,
    INFRASTRUCTURE_ERROR_CODES,
    isRetryableInfrastructureError
} from "../../../src/domain/infrastructure-error.js";

describe("infrastructure-error SSOT", () => {
    test("classifies QStash circuit breaker as retryable queue infrastructure", () => {
        const error = new Error("Circuit breaker is OPEN for qstash_publish");

        expect(classifyInfrastructureError(error)).toMatchObject({
            code: INFRASTRUCTURE_ERROR_CODES.QUEUE_CIRCUIT_OPEN,
            retryable: true,
            retryScope: "queue"
        });
        expect(isRetryableInfrastructureError(error)).toBe(true);
    });

    test("does not classify ordinary user-facing upload errors as infrastructure", () => {
        expect(classifyInfrastructureError("quota exceeded")).toMatchObject({
            code: INFRASTRUCTURE_ERROR_CODES.UNKNOWN,
            retryable: false
        });
    });
});
