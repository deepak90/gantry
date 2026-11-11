/**
 * What the assistant can do, as the cards its start page scrolls through: a topic, a line about it,
 * and the questions it opens (nothing is sent until one is picked).
 */
export interface Capability {
  icon: string;
  label: string;
  preview: string;
  questions: { label: string; prompt: string }[];
}

/** Two rows, scrolling in opposite directions on the assistant's start page. */
export const CAPABILITY_ROWS: [Capability[], Capability[]] = [
  [
    {
      icon: 'magnifying-glass',
      label: 'Find what is wrong',
      preview: 'Idle rental, late work, double bookings',
      questions: [
        { label: 'What needs attention?', prompt: 'What needs attention?' },
        { label: 'Is any equipment booked before its work can start?', prompt: 'Is any equipment booked before its work can start?' },
        { label: 'Who is double-booked next month?', prompt: 'Who is overbooked in the next month?' },
      ],
    },
    {
      icon: 'flag-checkered',
      label: 'Explain the handover',
      preview: 'What sets the date, and what would move it',
      questions: [
        { label: 'What sets the handover date?', prompt: 'What sets the handover date?' },
        { label: 'What happens if the steel is a week late?', prompt: 'What happens if the steel frame starts a week late?' },
      ],
    },
    {
      icon: 'book-bookmark',
      label: 'Draft a library piece',
      preview: 'Reusable work with crews, links and costs',
      questions: [
        { label: 'Draft a light-fixtures piece with costs', prompt: 'Draft a library piece for installing light fixtures on one floor: order, deliver, install, test, with costs.' },
        { label: 'Find work that repeats', prompt: 'Find reusable work for the library' },
      ],
    },
    {
      icon: 'coins',
      label: 'Add up the money',
      preview: 'Budgets, forecasts, what is due',
      questions: [
        { label: 'Total the costs by phase', prompt: 'Total the costs by phase' },
        { label: 'Who needs to be paid, and when?', prompt: 'Who needs to be paid, how much, and when?' },
      ],
    },
  ],
  [
    {
      icon: 'paypal',
      label: 'Pay a supplier',
      preview: 'Approved fixes paid through PayPal',
      questions: [
        { label: 'What is waiting to be paid?', prompt: 'What is waiting to be paid?' },
        { label: 'Show the last PayPal payment', prompt: 'Show the last PayPal payment and its receipt.' },
      ],
    },
    {
      icon: 'bell',
      label: 'Watch for trouble',
      preview: 'Rules that speak up when the plan changes',
      questions: [
        { label: 'Warn me about idle rental', prompt: 'Add a watch rule that warns me when rented equipment would stand idle.' },
        { label: 'What is on my watch list?', prompt: 'What is on my watch list?' },
      ],
    },
    {
      icon: 'clock-rotate-left',
      label: 'Catch up',
      preview: 'What changed, and who changed it',
      questions: [
        { label: 'What changed today?', prompt: 'What changed today?' },
        { label: 'What did the team change this morning?', prompt: 'What did the team change this morning?' },
      ],
    },
    {
      icon: 'graduation-cap',
      label: 'Show me how',
      preview: 'Short clips of the real app',
      questions: [
        { label: 'How do I invite someone into a conversation?', prompt: 'How do I invite someone into this conversation?' },
        { label: 'How do I save work to the library?', prompt: 'How do I save tasks to the library?' },
      ],
    },
  ],
];
