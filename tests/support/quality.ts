import { emptyQualityAssessment, type StageQualityAssessment } from '../../src/domain/quality/stage_quality.js';

/**
 * A stage assessment as production hands it to the gate: the stated fields over the empty
 * assessment, so every list the gate reads is present, as `normalizeQualityAssessment` makes it.
 */
export function stageAssessment(fields: Partial<StageQualityAssessment>): StageQualityAssessment {
  return { ...emptyQualityAssessment(), ...fields };
}
