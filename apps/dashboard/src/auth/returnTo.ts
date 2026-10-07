export function authReturnTo(location: {
  pathname: string;
  search: string;
  hash: string;
}): string {
  return `${location.pathname}${location.search}${location.hash}`;
}
