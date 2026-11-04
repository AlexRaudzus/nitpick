/**
 * Which query parameters make up "the page" on a site. Apps embedded via iframe often mirror their
 * route into the parent URL (`…/view?_route=%2Fteams%2Fproblems`); without this, every route of such
 * an app would count as one page. The user decides per site; route-like parameters are only suggested.
 */

export interface PageParamsPref {
  /** Parameters whose values distinguish pages, e.g. `['_route']`. */
  params: string[];
  /** The user answered (or changed it by hand), so no more suggestions. */
  decided?: boolean;
}

/** Per site, like the dock position. */
const KEY = 'nitpick:page-params';

export function loadPageParams(): PageParamsPref {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (v && Array.isArray(v.params)) return { params: v.params.filter((p: unknown) => typeof p === 'string'), decided: !!v.decided };
  } catch {
    // storage blocked or garbage: nothing chosen
  }
  return { params: [] };
}

export function savePageParams(pref: PageParamsPref) {
  try {
    localStorage.setItem(KEY, JSON.stringify(pref));
  } catch {
    // storage blocked: the choice only lasts for this page view
  }
}

/** Query parameter names of a URL, in order. */
export function queryParams(url: string): string[] {
  try {
    return [...new Set(new URL(url).searchParams.keys())];
  } catch {
    return [];
  }
}

/** Parameters whose value looks like a path (`/teams/W-IN`): candidates to suggest, never applied on their own. */
export function routeLikeParams(url: string): string[] {
  try {
    const u = new URL(url);
    return [...new Set(u.searchParams.keys())].filter((k) => u.searchParams.get(k)?.startsWith('/'));
  } catch {
    return [];
  }
}

/** Same origin and path, and the same values for the chosen parameters. */
export function samePage(a: string, b: string, params: string[] = []): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    if (ua.origin !== ub.origin || ua.pathname !== ub.pathname) return false;
    return params.every((p) => ua.searchParams.get(p) === ub.searchParams.get(p));
  } catch {
    return a === b;
  }
}

/** Short label for a comment's page: the path, plus the chosen parameters' values (`/view · /teams`). */
export function pageLabel(url: string, params: string[] = []): string {
  try {
    const u = new URL(url);
    const values = params.map((p) => u.searchParams.get(p)).filter((v): v is string => !!v);
    return [u.pathname, ...values].join(' · ');
  } catch {
    return url;
  }
}
