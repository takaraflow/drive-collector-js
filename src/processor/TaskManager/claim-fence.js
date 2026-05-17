export function getClaimFenceOptions(task) {
    if (!task?.claimedBy || !task?.claimLeaseId) {
        return {};
    }

    return {
        requireClaim: true,
        claimedBy: task.claimedBy,
        claimLeaseId: task.claimLeaseId
    };
}

export async function assertClaimFenceCurrent(task, instanceCoordinator) {
    if (!task?.claimedBy || !task?.claimLeaseId) {
        return;
    }

    if (typeof instanceCoordinator?.isLockLeaseCurrent !== 'function') {
        return;
    }

    const isCurrent = await instanceCoordinator.isLockLeaseCurrent("telegram_client", {
        instanceId: task.claimedBy,
        leaseId: task.claimLeaseId
    });

    if (!isCurrent) {
        throw new Error("Task claim lease is no longer current");
    }
}
