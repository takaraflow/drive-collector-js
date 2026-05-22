function normalizeClaimFenceSource(source) {
    if (!source) {
        return {};
    }

    return {
        claimedBy: source.claimedBy || source.instanceId || null,
        claimLeaseId: source.claimLeaseId || source.leaseId || null
    };
}

export const CLAIM_FENCE_STALE_ERROR_CODE = "TASK_CLAIM_LEASE_STALE";

export class ClaimFenceStaleError extends Error {
    constructor(message = "Task claim lease is no longer current", details = {}) {
        super(message);
        this.name = "ClaimFenceStaleError";
        this.code = CLAIM_FENCE_STALE_ERROR_CODE;
        this.retryable = true;
        this.retryScope = "lock";
        this.details = details;
    }
}

export function isClaimFenceStaleError(error) {
    return error?.code === CLAIM_FENCE_STALE_ERROR_CODE
        || error instanceof ClaimFenceStaleError;
}

export function isClaimFenceConflictReason(reason) {
    return /claim lease|lease is no longer current|lease no longer matches/i.test(String(reason || ""));
}

export function createClaimFenceStaleError(reason, details = {}) {
    return new ClaimFenceStaleError(
        reason || "Task claim lease is no longer current",
        details
    );
}

export function getClaimFenceOptions(source) {
    const { claimedBy, claimLeaseId } = normalizeClaimFenceSource(source);
    if (!claimedBy || !claimLeaseId) {
        return {};
    }

    return {
        requireClaim: true,
        claimedBy,
        claimLeaseId
    };
}

export function attachClaimLease(task, lease) {
    const { claimedBy, claimLeaseId } = normalizeClaimFenceSource(lease);
    if (!task || !claimedBy || !claimLeaseId) {
        return task;
    }

    task.claimedBy = claimedBy;
    task.claimLeaseId = claimLeaseId;
    return task;
}

export async function assertClaimFenceCurrent(task, instanceCoordinator) {
    const { claimedBy, claimLeaseId } = normalizeClaimFenceSource(task);
    if (!claimedBy || !claimLeaseId) {
        return;
    }

    if (typeof instanceCoordinator?.isLockLeaseCurrent !== 'function') {
        return;
    }

    const isCurrent = await instanceCoordinator.isLockLeaseCurrent("telegram_client", {
        instanceId: claimedBy,
        leaseId: claimLeaseId
    });

    if (!isCurrent) {
        throw createClaimFenceStaleError("Task claim lease is no longer current", {
            claimedBy,
            claimLeaseId
        });
    }
}
