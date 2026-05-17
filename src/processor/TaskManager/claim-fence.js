function normalizeClaimFenceSource(source) {
    if (!source) {
        return {};
    }

    return {
        claimedBy: source.claimedBy || source.instanceId || null,
        claimLeaseId: source.claimLeaseId || source.leaseId || null
    };
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
        throw new Error("Task claim lease is no longer current");
    }
}
