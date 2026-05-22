import { describe, expect, it } from 'vitest';

import {
    CLAIM_FENCE_STALE_ERROR_CODE,
    assertClaimFenceCurrent,
    attachClaimLease,
    getClaimFenceOptions,
    isClaimFenceConflictReason,
    isClaimFenceStaleError
} from '../../src/processor/TaskManager/claim-fence.js';

describe('TaskManager claim fence helpers', () => {
    it('builds transition fence options from a claimed task', () => {
        expect(getClaimFenceOptions({
            claimedBy: 'instance-1',
            claimLeaseId: 'lease-1'
        })).toEqual({
            requireClaim: true,
            claimedBy: 'instance-1',
            claimLeaseId: 'lease-1'
        });
    });

    it('builds transition fence options from a leader lease', () => {
        expect(getClaimFenceOptions({
            instanceId: 'instance-2',
            leaseId: 'lease-2'
        })).toEqual({
            requireClaim: true,
            claimedBy: 'instance-2',
            claimLeaseId: 'lease-2'
        });
    });

    it('does not request claim fencing when the source is incomplete', () => {
        expect(getClaimFenceOptions({ claimedBy: 'instance-1' })).toEqual({});
        expect(getClaimFenceOptions({ claimLeaseId: 'lease-1' })).toEqual({});
        expect(getClaimFenceOptions(null)).toEqual({});
    });

    it('attaches a normalized leader lease to task context', () => {
        const task = { id: 'task-1' };

        expect(attachClaimLease(task, {
            instanceId: 'instance-1',
            leaseId: 'lease-1'
        })).toBe(task);
        expect(task).toMatchObject({
            claimedBy: 'instance-1',
            claimLeaseId: 'lease-1'
        });
    });

    it('leaves task context unchanged when the lease is incomplete', () => {
        const task = { id: 'task-1' };

        expect(attachClaimLease(task, { instanceId: 'instance-1' })).toBe(task);
        expect(task).toEqual({ id: 'task-1' });
    });

    it('throws a structured retryable error when the claim lease is stale', async () => {
        const error = await assertClaimFenceCurrent(
            {
                id: 'task-1',
                claimedBy: 'instance-1',
                claimLeaseId: 'lease-1'
            },
            {
                isLockLeaseCurrent: async () => false
            }
        ).catch(e => e);

        expect(error).toBeInstanceOf(Error);
        expect(error.code).toBe(CLAIM_FENCE_STALE_ERROR_CODE);
        expect(error.retryable).toBe(true);
        expect(error.retryScope).toBe('lock');
        expect(isClaimFenceStaleError(error)).toBe(true);
    });

    it('recognizes repository claim fence conflict reasons', () => {
        expect(isClaimFenceConflictReason('Task claim lease no longer matches current worker')).toBe(true);
        expect(isClaimFenceConflictReason('Task status changed concurrently from uploading to completed')).toBe(false);
    });
});
