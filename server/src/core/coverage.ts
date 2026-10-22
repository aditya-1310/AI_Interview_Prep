import type { Coverage, Kit, Requirement, RequirementPriority } from './types';

/**
 * Coverage is computed in code, never by the model: a requirement is covered
 * when at least one question references its id. Only must-have gaps can make
 * a kit unshippable; nice-to-have gaps are reported as warnings.
 */

export function stripDanglingRefs(kit: Kit): Kit {
  const reqIds = new Set(kit.role.requirements.map((r) => r.id));
  kit.questions = kit.questions.map((q) => ({
    ...q,
    requirement_ids: q.requirement_ids.filter((id) => reqIds.has(id)),
  }));
  kit.flashcards = kit.flashcards.map((f) => ({
    ...f,
    requirement_ids: f.requirement_ids.filter((id) => reqIds.has(id)),
  }));
  return kit;
}

export function uncoveredRequirementIds(kit: Kit, priority: RequirementPriority): string[] {
  const covered = new Set(kit.questions.flatMap((q) => q.requirement_ids));
  return kit.role.requirements
    .filter((r) => r.priority === priority && !covered.has(r.id))
    .map((r) => r.id);
}

export function computeCoverage(kit: Kit, passes: number): Coverage {
  return {
    uncovered_requirement_ids: uncoveredRequirementIds(kit, 'must'),
    passes,
  };
}

/** Category a gap-filling question for a requirement should land in. */
export function categoryForRequirement(req: Requirement): Kit['questions'][number]['category'] {
  switch (req.kind) {
    case 'behavioural':
      return 'behavioural';
    case 'domain':
    case 'technical':
    default:
      return 'technical';
  }
}
