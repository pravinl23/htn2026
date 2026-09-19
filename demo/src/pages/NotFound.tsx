export function NotFound() {
  return (
    <main className="page index">
      <h1>Page not found</h1>
      <p className="lede">
        There is no demo page at <code>{window.location.pathname}</code>.
      </p>
      <p>
        <a href="/">Back to the demo index</a>
      </p>
    </main>
  );
}
