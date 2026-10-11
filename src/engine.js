import constitution from '../constitution.json' with { type: 'json' };
import { id, appendDecision, audit, digest } from './store.js';

export { constitution };
const protectedFields = new Set(['race', 'ethnicity', 'gender', 'age', 'religion', 'disability', 'national_origin']);
const limits = constitution.provisions.find(p => p.id === 'ART-2')?.parameters ?? {};
const hardBlocks = new Set(['ART-1', 'ART-2', 'ART-3', 'ART-4', 'ART-5']);
const asObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

function checks(input) {
  const action = asObject(input.action);
  const context = asObject(input.context);
  const observation = asObject(input.observation);
  const features = asObject(observation.features);
  const hasAmount = Object.hasOwn(action, 'amount') || Object.hasOwn(action, 'total_value');
  const rawAmount = Object.hasOwn(action, 'amount') ? action.amount : action.total_value;
  const amount = rawAmount === undefined ? 0 : rawAmount;
  const dailyExposure = Number(context.daily_exposure ?? 0) + (typeof amount === 'number' ? amount : 0);
  const counterparty = Number(context.counterparty_exposure ?? 0) + (typeof amount === 'number' ? amount : 0);
  const rationaleValid = typeof input.rationale === 'string' && input.rationale.trim().length > 0;
  const evidenceValid = typeof input.evidence === 'string' && input.evidence.trim().length > 0;
  const protectedPresent = Object.keys(features).filter(key => protectedFields.has(key.toLowerCase()));
  const approvalRequired = typeof action.type === 'string' && /\b(spend(?:ing)?|sales[\s_-]*handoff|customer[\s_-]*(?:offer|commitment|outcome|risk)|offer|commitment|production[\s_-]*change)\b/i.test(action.type);
  const validContext = ['daily_exposure', 'counterparty_exposure'].every(key => context[key] === undefined || (typeof context[key] === 'number' && Number.isFinite(context[key]) && context[key] >= 0));
  return [
    { provision: 'ART-1', check: 'action_type_present', passed: typeof action.type === 'string' && action.type.trim().length > 0 && action.type.length <= 80, actual: action.type ?? null },
    { provision: 'ART-1', check: 'amount_valid', passed: !hasAmount || (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0), actual: amount },
    { provision: 'ART-1', check: 'exposure_context_valid', passed: validContext, actual: { daily_exposure: context.daily_exposure ?? 0, counterparty_exposure: context.counterparty_exposure ?? 0 } },
    { provision: 'ART-2', check: 'max_single_transaction', limit: limits.max_single_transaction, actual: amount, passed: typeof amount === 'number' && amount <= limits.max_single_transaction },
    { provision: 'ART-2', check: 'max_daily_exposure', limit: limits.max_daily_exposure, actual: dailyExposure, passed: Number.isFinite(dailyExposure) && dailyExposure <= limits.max_daily_exposure },
    { provision: 'ART-2', check: 'max_counterparty_exposure', limit: limits.max_counterparty_exposure, actual: counterparty, passed: Number.isFinite(counterparty) && counterparty <= limits.max_counterparty_exposure },
    { provision: 'ART-2', check: 'owner_approval_required_for_any_spend', actual: amount, passed: amount === 0 },
    { provision: 'ART-3', check: 'protected_features_absent', actual: protectedPresent, passed: protectedPresent.length === 0 },
    { provision: 'ART-4', check: 'evidence_attached', actual: evidenceValid, passed: evidenceValid },
    { provision: 'ART-5', check: 'rationale_present', actual: rationaleValid, passed: rationaleValid },
    { provision: 'ART-5', check: 'sensitive_actions_use_founder_approval_workflow', actual: action.type ?? null, passed: !approvalRequired }
  ];
}

export function evaluate(value) {
  const input = asObject(value);
  const constraint_evaluations = checks(input);
  const failed = constraint_evaluations.filter(check => !check.passed);
  return {
    allowed: failed.length === 0,
    hard_blocked: failed.some(check => hardBlocks.has(check.provision)),
    constraint_evaluations,
    constitutional_version: constitution.version,
    execution: 'This control plane records decisions; it does not execute external transactions.'
  };
}

export function execute(value, actor = 'owner') {
  const input = asObject(value);
  const evaluated = evaluate(input);
  const timestamp = new Date().toISOString();
  const record = {
    id: id('dec'),
    timestamp,
    agent_id: actor,
    status: evaluated.allowed ? 'recorded' : 'blocked',
    observation: asObject(input.observation),
    planning: { goal: input.goal ?? 'unspecified', strategy: input.strategy ?? 'constitutional evaluation' },
    action: asObject(input.action),
    evidence: typeof input.evidence === 'string' ? input.evidence : null,
    rationale: typeof input.rationale === 'string' ? input.rationale : null,
    constitutional_context: { version: constitution.version, applicable_provisions: constitution.provisions.map(p => p.id), constraint_evaluations: evaluated.constraint_evaluations },
    execution: { status: 'not_executed', recorded_at: timestamp },
    confidence: typeof input.confidence === 'number' && Number.isFinite(input.confidence) ? Math.max(0, Math.min(1, input.confidence)) : null,
    audit: { input_hash: digest(input) }
  };
  const saved = appendDecision(record);
  audit('decision.lineage', { decision_id: saved.id });
  return { ...saved, evaluation: evaluated };
}
