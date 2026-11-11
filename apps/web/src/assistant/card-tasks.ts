/**
 * Which tasks a card from the assistant is about: what a 3D view goes to when the card arrives, or when someone picks
 * one of its options. A card stored before cards named their tasks simply has none.
 */
const ids = (value: unknown): number[] => (Array.isArray(value) ? value.filter((id): id is number => typeof id === 'number') : []);

const asRecords = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null) : []);

export function tasksOfCard(component: string, props: Record<string, unknown> | null): number[] {
  if (!props) return [];
  switch (component) {
    case 'show_issue_card':
    case 'show_tasks':
      return ids(props.task_ids);
    case 'show_task':
      return ids([props.task_id]);
    case 'show_findings':
      // The one on top is what the card is telling them first.
      return asRecords(props.findings).map((finding) => ids(finding.task_ids)).find((found) => found.length > 0) ?? [];
    case 'show_plan_edit':
      // A task being added has no place to go to yet; the tasks around it do.
      return [...new Set(asRecords(props.operations).flatMap((operation) => ids([operation.task, operation.from, operation.to])))];
    default:
      return [];
  }
}
