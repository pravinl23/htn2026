import { useEffect } from "react";
import { Index } from "./pages/Index";
import { NotFound } from "./pages/NotFound";
import { usePathname } from "./router";
import { matchRouteWithParams, type DemoRoute } from "./routes";

// Static pages only reach React through the SPA fallback (for example "/apply-plain" without the slash).
function StaticRedirect({ route }: { route: DemoRoute }) {
  const alreadyThere = window.location.pathname === route.path;
  useEffect(() => {
    if (!alreadyThere) window.location.replace(route.path);
  }, [alreadyThere, route.path]);
  return alreadyThere ? <NotFound /> : null;
}

export function App() {
  const pathname = usePathname();
  const match = matchRouteWithParams(pathname);
  const route = match?.route;

  useEffect(() => {
    document.title = route ? `${route.title} · Ghost demo` : "Ghost demo sites";
  }, [route]);

  if (pathname === "/") return <Index />;
  if (!match || !route) return <NotFound />;
  if (!route.component) return <StaticRedirect route={route} />;
  const Page = route.component;
  return <Page key={pathname} params={match.params} />;
}
