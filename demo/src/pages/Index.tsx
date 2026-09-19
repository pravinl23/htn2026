import { ROUTES } from "../routes";

export function Index() {
  return (
    <main className="page index">
      <p className="eyebrow">Ghost</p>
      <h1>Demo sites</h1>
      <p className="lede">
        Local pages that Ghost is developed and tested against. Everything here is fictional and nothing
        leaves your machine.
      </p>
      <ul className="demo-list">
        {ROUTES.filter((route) => route.listed).map((route) => (
          <li key={route.path}>
            <a className="demo-card" href={route.path}>
              <span className="demo-card-title">{route.title}</span>
              <span className="demo-card-blurb">{route.blurb}</span>
              <code>{route.path}</code>
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}
