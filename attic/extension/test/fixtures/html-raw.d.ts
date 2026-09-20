// Vite serves "?raw" imports as strings; this package has no vite/client types, so declare the one shape the tests use.
declare module "*.html?raw" {
  const html: string;
  export default html;
}
