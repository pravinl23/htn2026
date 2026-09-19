const RESPONSIBILITIES = [
  "Ship production code for the fleet dashboard our customers use to monitor hundreds of warehouse robots in real time (TypeScript, React, Go).",
  "Build tooling that replays robot telemetry so engineers can reproduce navigation bugs in minutes instead of days.",
  "Work with the perception team to surface model confidence and failure cases to operators in a way they can act on.",
  "Write tests, review code, and take part in a weekly on-call shadow rotation with a senior engineer.",
  "Demo what you built to the whole company at the end of the term.",
];

const QUALIFICATIONS = [
  "Currently enrolled in a computer science, software engineering, or related degree program.",
  "Comfortable in at least one of TypeScript, Python, Go, or C++, and curious about the others.",
  "A project you can walk us through: a hackathon build, open source contribution, course project, or something you made for fun.",
  "Clear written communication. Most of our design discussion happens in documents.",
];

const PERKS = [
  "Competitive intern salary, paid biweekly",
  "A dedicated mentor and a real project that ships",
  "Hybrid schedule: three days a week in our Waterloo lab",
  "Robot test floor access (safety training included)",
];

function BulletList({ items }: { items: string[] }) {
  return (
    <ul>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

export function JobDescription() {
  return (
    <section className="job" aria-labelledby="job-title" data-testid="job-description">
      <p className="eyebrow">Northwind Robotics · Engineering</p>
      <h1 id="job-title">Software Engineering Intern</h1>
      <ul className="job-meta" aria-label="Job details">
        <li>Waterloo, ON (hybrid)</li>
        <li>Winter 2027, 4 months</li>
        <li>Full-time internship</li>
      </ul>

      <h2>About Northwind Robotics</h2>
      <p>
        Northwind Robotics builds autonomous mobile robots that move inventory through warehouses and
        hospitals. Our robots have driven more than two million kilometres across 140 customer sites in
        Canada and the United States. We are a team of 85 people who care about reliable software, clear
        thinking, and leaving things better than we found them.
      </p>

      <h2>The role</h2>
      <p>
        As a Software Engineering Intern you will join the Fleet Platform team, the group responsible for
        the cloud services and web tools that operators use to run their robots every day. You will own a
        scoped project from design document to production, with a mentor who reviews your work and helps
        you grow.
      </p>

      <h2>What you will do</h2>
      <BulletList items={RESPONSIBILITIES} />

      <h2>What we are looking for</h2>
      <BulletList items={QUALIFICATIONS} />

      <h2>What we offer</h2>
      <BulletList items={PERKS} />
    </section>
  );
}
