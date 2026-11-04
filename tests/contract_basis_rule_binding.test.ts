import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessRequestInputError } from '../src/application/execution/business_request_input.js';
import { CONTRACT_BASIS_RULE } from '../src/application/execution/contract_basis_judge.js';
import { judgeRuntimeContractBasis } from '../src/runtime/contract_basis_judgement.js';
import { prepareRuntimeRuleRequest } from '../src/runtime/rules.js';
import { sendRuntimeBusinessResponse } from '../src/runtime/business_request_recovery.js';

vi.mock('../src/runtime/rules.js', () => ({ prepareRuntimeRuleRequest: vi.fn() }));
vi.mock('../src/runtime/business_request_recovery.js', () => ({ sendRuntimeBusinessResponse: vi.fn() }));

/** The rubric lives only in its Rule: a judge asked without it would answer from nothing. */
describe('a contract basis judgement', () => {
  beforeEach(() => { vi.mocked(sendRuntimeBusinessResponse).mockReset(); });
  const judge = (requiredRuleIds: string[]) => {
    vi.mocked(prepareRuntimeRuleRequest).mockResolvedValue({ requiredRuleIds, digest: 'sha256:x' } as never);
    return judgeRuntimeContractBasis({
      config: {} as never, container: { root: '/x', state: { abs: () => '/x/audit' } } as never, recordReplay: {} as never, audit: {} as never,
      router: { resolvePool: () => ({ modelPool: 'management', inheritFallbacks: true, allowedProviders: ['fixture'] }) } as never,
      projectId: '01952f27-7900-7000-8000-000000000001', phaseId: '01952f27-7900-7000-8000-000000000002',
      actor: { actorId: '01952f27-7900-7000-8000-000000000003', role: 'project-manager', roleVersion: '1' } as never,
      judgement: { test: 'tests/x.py', proposedChange: '{}', reason: 'r', citedContract: 'c' },
    });
  };

  it('is never asked without the Rule that holds its rubric', async () => {
    await expect(judge(['another-rule'])).rejects.toBeInstanceOf(BusinessRequestInputError);
    expect(sendRuntimeBusinessResponse).not.toHaveBeenCalled();
  });

  it('goes on to the model when the Rule is bound', async () => {
    vi.mocked(sendRuntimeBusinessResponse).mockRejectedValue(new Error('Stop at the send.'));
    await expect(judge([CONTRACT_BASIS_RULE.ruleId])).rejects.toThrow('Stop at the send.');
  });
});
