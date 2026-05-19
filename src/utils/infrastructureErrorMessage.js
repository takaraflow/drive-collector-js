import { INFRASTRUCTURE_ERROR_CODES } from "../domain/infrastructure-error.js";
import { STRINGS } from "../locales/zh-CN.js";

const INFRASTRUCTURE_ERROR_MESSAGES = Object.freeze({
    [INFRASTRUCTURE_ERROR_CODES.QUEUE_CIRCUIT_OPEN]: STRINGS.task.error_queue_temporarily_unavailable,
    [INFRASTRUCTURE_ERROR_CODES.QUEUE_UNAVAILABLE]: STRINGS.task.error_queue_temporarily_unavailable,
    [INFRASTRUCTURE_ERROR_CODES.LOCK_BUSY]: STRINGS.task.error_queue_temporarily_unavailable,
    [INFRASTRUCTURE_ERROR_CODES.CACHE_UNAVAILABLE]: STRINGS.task.error_queue_temporarily_unavailable,
    [INFRASTRUCTURE_ERROR_CODES.NETWORK_TRANSIENT]: STRINGS.task.error_infrastructure_transient,
    [INFRASTRUCTURE_ERROR_CODES.DATABASE_TRANSIENT]: STRINGS.task.error_infrastructure_transient
});

export function getInfrastructureErrorUserMessage(errorCode) {
    return INFRASTRUCTURE_ERROR_MESSAGES[errorCode] || null;
}
