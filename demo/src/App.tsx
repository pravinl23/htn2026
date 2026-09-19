const PAGES: Array<{ path: string; title: string; blurb: string }> = [
  { path: "/apply", title: "Job application (React)", blurb: "Northwind Robotics, Software Engineering Intern" },
  { path: "/apply-plain/", title: "Job application (plain HTML)", blurb: "Same form without a framework" },
];

export function App() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "48px auto", padding: "0 16px" }}>
      <h1>Ghost demo sites</h1>
      <ul>
        {PAGES.map((p) => (
          <li key={p.path}>
            <a href={p.path}>{p.title}</a>: {p.blurb}
          </li>
        ))}
      </ul>
    </main>
  );
}
