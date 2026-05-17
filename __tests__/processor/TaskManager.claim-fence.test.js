import { describe, expect, it } from 'vitest';

import {
    attachClaimLease,
    getClaimFenceOptions
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
});
