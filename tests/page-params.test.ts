import { describe, expect, it } from 'vitest';
import { pageLabel, routeLikeParams, samePage } from '@/core/ui/page-params';

const app = 'https://dev.qualitat.io/isb/solutions/app/6acf/view';

describe('page params', () => {
  it('matches on path only unless parameters are chosen', () => {
    const a = `${app}?_route=%2Fteams%2FW-IN%2Fproblems&tab=1`;
    const b = `${app}?_route=%2Fteams%2FW-IN&tab=2`;
    expect(samePage(a, b)).toBe(true);
    expect(samePage(a, b, ['_route'])).toBe(false);
    expect(samePage(a, `${app}?tab=9&_route=/teams/W-IN/problems`, ['_route'])).toBe(true);
    expect(samePage(`${app}?_route=/x`, `${app}`, ['_route'])).toBe(false);
    expect(samePage(`https://other.io/isb/solutions/app/6acf/view`, app)).toBe(false);
  });

  it('suggests parameters whose value looks like a path', () => {
    expect(routeLikeParams(`${app}?_route=%2Fteams&tab=1&q=a%2Fb`)).toEqual(['_route']);
    expect(routeLikeParams(app)).toEqual([]);
  });

  it('labels a page with the chosen parameter values', () => {
    expect(pageLabel(`${app}?_route=%2Fteams%2FW-IN`, ['_route'])).toBe('/isb/solutions/app/6acf/view · /teams/W-IN');
    expect(pageLabel(`${app}?_route=%2Fteams`)).toBe('/isb/solutions/app/6acf/view');
  });
});
