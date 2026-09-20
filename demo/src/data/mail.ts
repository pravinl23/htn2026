/**
 * The fictional inbox shown on /mail. Every person, company, and address is invented (example.com only).
 * Subjects double as link names that Shabang reads, so they avoid words its lock rules treat as irreversible
 * ("send", "submit", "confirm", "delete"...): opening an email must never look like a locked action.
 */
export interface MailPerson {
  name: string;
  email: string;
}

export interface MailMessage {
  /** Contains digits so Shabang generalizes /mail/msg-1001 to /mail/:id. */
  id: string;
  from: MailPerson;
  subject: string;
  preview: string;
  /** Short date for the inbox row. */
  dateShort: string;
  /** Full date for the message header. */
  dateLong: string;
  unread: boolean;
  /** One entry per paragraph. */
  body: string[];
}

export const ME: MailPerson = { name: "Alex Chen", email: "alex.chen.dev@example.com" };

export const MEETING_REQUEST_ID = "msg-1001";

export const MESSAGES: readonly MailMessage[] = [
  {
    id: MEETING_REQUEST_ID,
    from: { name: "Priya Nair", email: "priya.nair@example.com" },
    subject: "Quick chat Thursday afternoon?",
    preview: "Thanks for applying to the Software Engineering Intern role. Can we meet Thursday afternoon?",
    dateShort: "Sep 18",
    dateLong: "Fri, Sep 18, 2026, 4:12 PM",
    unread: true,
    body: [
      "Hi Alex,",
      "Thanks for applying to the Software Engineering Intern role at Northwind Robotics. I enjoyed reading about your capstone project and would love a quick intro chat.",
      "Can we meet Thursday afternoon (Sep 24) for 30 minutes? Let me know a time between 1 PM and 5 PM that works for you and I will set up the video call.",
      "Best,",
      "Priya Nair\nUniversity Recruiter, Northwind Robotics",
    ],
  },
  {
    id: "msg-1002",
    from: { name: "Marcus Oyelaran", email: "marcus.oyelaran@example.com" },
    subject: "Capstone design review notes",
    preview: "Here are my notes from Wednesday. The main open question is how the arm controller recovers from a dropped packet.",
    dateShort: "Sep 18",
    dateLong: "Fri, Sep 18, 2026, 11:40 AM",
    unread: true,
    body: [
      "Hey Alex,",
      "Here are my notes from Wednesday. The main open question is how the arm controller recovers from a dropped packet. Dana suggested a heartbeat every 50 ms with a safe stop after three misses.",
      "I can take the simulator changes if you take the firmware side. Let's split it up at Monday's sync.",
      "Marcus",
    ],
  },
  {
    id: "msg-1003",
    from: { name: "Campus Robotics Club", email: "robotics.club@example.com" },
    subject: "Build night moved to room 2104",
    preview: "Monday's build night is in room 2104 this week because the usual lab is being rewired.",
    dateShort: "Sep 17",
    dateLong: "Thu, Sep 17, 2026, 6:05 PM",
    unread: false,
    body: [
      "Hi everyone,",
      "Monday's build night is in room 2104 this week because the usual lab is being rewired. Same time, 3:30 PM. Bring your safety glasses, we are cutting the new chassis plates.",
      "See you there,\nThe exec team",
    ],
  },
  {
    id: "msg-1004",
    from: { name: "Dana Whitfield", email: "dana.whitfield@example.com" },
    subject: "Operating Systems lab 3 feedback",
    preview: "Nice work on the scheduler. One note: your priority queue starves low priority tasks under sustained load.",
    dateShort: "Sep 17",
    dateLong: "Thu, Sep 17, 2026, 2:22 PM",
    unread: false,
    body: [
      "Hi Alex,",
      "Nice work on the scheduler. One note: your priority queue starves low priority tasks under sustained load. Aging would fix it, and it is worth two of the three marks you lost.",
      "Come by office hours on Tuesday if you want to walk through it.",
      "Dana Whitfield\nTeaching Assistant",
    ],
  },
  {
    id: "msg-1005",
    from: { name: "Jordan Reyes", email: "jordan.reyes@example.com" },
    subject: "Lunch Tuesday?",
    preview: "Are we still on for noon on Tuesday? I found a new noodle place near the engineering building.",
    dateShort: "Sep 16",
    dateLong: "Wed, Sep 16, 2026, 9:15 PM",
    unread: false,
    body: [
      "Alex!",
      "Are we still on for noon on Tuesday? I found a new noodle place near the engineering building and I have been told the dan dan noodles are worth the line.",
      "Jordan",
    ],
  },
  {
    id: "msg-1006",
    from: { name: "Cogwheel Cycles", email: "service@example.com" },
    subject: "Your bike tune-up is ready for pickup",
    preview: "Good news, your tune-up is done. We replaced the rear brake pads and trued the front wheel.",
    dateShort: "Sep 16",
    dateLong: "Wed, Sep 16, 2026, 3:48 PM",
    unread: false,
    body: [
      "Hi Alex,",
      "Good news, your tune-up is done. We replaced the rear brake pads and trued the front wheel. The shop is open until 6 PM on weekdays.",
      "Cogwheel Cycles",
    ],
  },
  {
    id: "msg-1007",
    from: { name: "Library Services", email: "library@example.com" },
    subject: "Due soon: 2 library items",
    preview: "Two items on loan to you are due on Sep 25. You can renew them online unless another reader has a hold.",
    dateShort: "Sep 15",
    dateLong: "Tue, Sep 15, 2026, 8:00 AM",
    unread: false,
    body: [
      "Hello Alex,",
      "Two items on loan to you are due on Sep 25. You can renew them online unless another reader has placed a hold.",
      "Library Services",
    ],
  },
  {
    id: "msg-1008",
    from: { name: "Harbourlight Hackathon", email: "organizers@example.com" },
    subject: "Hackathon planning agenda for Tuesday",
    preview: "Agenda for Tuesday at 3 PM: venue walkthrough, sponsor table layout, and the judging rubric.",
    dateShort: "Sep 14",
    dateLong: "Mon, Sep 14, 2026, 5:30 PM",
    unread: false,
    body: [
      "Hi team,",
      "Agenda for Tuesday at 3 PM: venue walkthrough, sponsor table layout, and the judging rubric. Alex, could you bring the draft of the mentor schedule?",
      "Thanks,\nThe organizers",
    ],
  },
];

export function findMessage(id: string | undefined): MailMessage | undefined {
  return id === undefined ? undefined : MESSAGES.find((message) => message.id === id);
}

export function formatPerson(person: MailPerson): string {
  return `${person.name} <${person.email}>`;
}

export function messagePath(id: string): string {
  return `/mail/${encodeURIComponent(id)}`;
}
