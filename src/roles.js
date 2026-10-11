export const roles = {
  reception: {
    name: 'Reception', department: 'reception', purpose: 'Capture incoming enquiries and route them for review.',
    permissions: ['Create enquiry records', 'Create reception tasks', 'Prepare customer message drafts'],
    boundaries: ['Cannot access sales queue before owner-approved handoff', 'Drafts are never sent by this workspace', 'Cannot promise outcomes or spend money']
  },
  marketing: {
    name: 'Marketing', department: 'marketing', purpose: 'Prepare and organize marketing work and qualify enquiries.',
    permissions: ['Create enquiry records', 'Move enquiries into marketing review', 'Request sales handoff', 'Create marketing tasks', 'Prepare customer message drafts'],
    boundaries: ['Cannot publish or send campaigns', 'Cannot move a lead into Sales without owner approval', 'Drafts are never sent by this workspace', 'Cannot make customer offers or commitments or spend money']
  },
  sales: {
    name: 'Sales', department: 'sales', purpose: 'Work owner-approved sales handoffs and prepare proposed offers.',
    permissions: ['Work leads in the sales queue', 'Request offers, commitments, and customer outcome decisions', 'Create sales tasks', 'Prepare customer message drafts'],
    boundaries: ['Cannot access unapproved marketing enquiries', 'Cannot make offers or commitments without owner approval', 'Drafts are never sent by this workspace', 'Cannot mark a lead won or lost without owner approval or spend money']
  },
  finance: {
    name: 'Finance & Accounting', department: 'finance', purpose: 'Prepare financial work and document proposed expenditure.',
    permissions: ['Create finance tasks', 'Request approval for a specified expense'],
    boundaries: ['Cannot initiate a payment or incur a cost', 'Every positive amount requires owner approval', 'Cannot change approval records']
  },
  technical: {
    name: 'Technical', department: 'technical', purpose: 'Track technical work and prepare proposed system changes.',
    permissions: ['Create technical tasks', 'Request approval for a production change'],
    boundaries: ['Cannot deploy or change production systems through this workspace', 'Cannot incur a cost']
  },
  operations: {
    name: 'Operations', department: 'operations', purpose: 'Coordinate internal work and maintain operational task status.',
    permissions: ['Create operations tasks'],
    boundaries: ['Cannot spend money', 'Cannot change customer or financial outcomes']
  },
  administration: {
    name: 'Administration', department: 'administration', purpose: 'Prepare and organize administrative work.',
    permissions: ['Create administration tasks'],
    boundaries: ['Cannot spend money', 'Cannot make customer commitments or change approvals']
  }
};

export const leadStages = ['enquiry', 'marketing_review', 'sales_queue', 'sales_working', 'customer', 'closed_lost'];
export const taskStatuses = ['open', 'in_progress', 'done'];
export const approvalKinds = {
  spend: 'Proposed spend',
  sales_handoff: 'Marketing to Sales handoff',
  customer_offer: 'Customer offer',
  customer_commitment: 'Customer commitment',
  customer_outcome: 'Customer outcome',
  customer_risk: 'At-risk customer action',
  production_change: 'Production change'
};

export function agentCanRequest(role, kind) {
  if (!roles[role] || !approvalKinds[kind]) return false;
  if (kind === 'spend') return true;
  if (kind === 'sales_handoff') return role === 'marketing';
  if (['customer_offer', 'customer_commitment', 'customer_outcome', 'customer_risk'].includes(kind)) return role === 'sales';
  if (kind === 'production_change') return role === 'technical';
  return false;
}
